import * as solace from 'solclientjs';
import * as Sentry from '@sentry/node';
import { getSolaceConfig } from '../config/jms';
import { logger } from '../config/logger';
import { getPoolStats } from '../config/database';
import { NOTAMParser } from './notam-parser';
import { NOTAMModel } from '../models/notam';
import { CircuitBreaker } from '../utils/circuit-breaker';

export class NOTAMIngestionService {
  private session: solace.Session | null = null;
  private messageConsumer: solace.MessageConsumer | null = null;
  private parser: NOTAMParser;
  private notamModel: NOTAMModel;
  private isRunning = false;
  private circuitBreaker: CircuitBreaker;

  constructor() {
    this.parser = new NOTAMParser();
    this.notamModel = new NOTAMModel();
    this.circuitBreaker = new CircuitBreaker();

    // Initialize Solace factory
    const factoryProps = new solace.SolclientFactoryProperties();
    factoryProps.profile = solace.SolclientFactoryProfiles.version10;
    solace.SolclientFactory.init(factoryProps);

    logger.info('Solace factory initialized');
  }

  /**
   * Start the Solace ingestion service
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Ingestion service already running');
      return;
    }

    try {
      const config = getSolaceConfig();

      // Create session properties
      const sessionProperties = new solace.SessionProperties({
        url: config.url,
        vpnName: config.vpnName,
        userName: config.username,
        password: config.password,
        connectRetries: 3,
        connectTimeoutInMsecs: 10000,
        reconnectRetries: 20,
        reconnectRetryWaitInMsecs: 3000,
        readTimeoutInMsecs: 10000,
        generateSendTimestamps: false,
        generateReceiveTimestamps: false,
        includeSenderId: false,
        generateSequenceNumber: false,
      });

      // Create session
      this.session = solace.SolclientFactory.createSession(sessionProperties);

      // Set up event listeners
      this.setupEventListeners(config.queueName);

      // Connect
      logger.info({ url: config.url, vpn: config.vpnName }, 'Connecting to Solace broker');
      this.session.connect();
    } catch (error) {
      logger.error({ error }, 'Failed to start ingestion service');
      Sentry.captureException(error);
      throw error;
    }
  }

  /**
   * Set up session event listeners
   */
  private setupEventListeners(queueName: string): void {
    if (!this.session) return;

    this.session.on(solace.SessionEventCode.UP_NOTICE, () => {
      logger.info('Connected to Solace broker');
      this.isRunning = true;
      this.subscribeToQueue(queueName);
    });

    this.session.on(solace.SessionEventCode.CONNECT_FAILED_ERROR, (sessionEvent) => {
      logger.error({ error: sessionEvent.toString() }, 'Connection failed');
      Sentry.captureException(new Error(`Connection failed: ${sessionEvent.toString()}`));
    });

    this.session.on(solace.SessionEventCode.DISCONNECTED, () => {
      logger.warn('Disconnected from Solace broker');
      this.isRunning = false;

      if (this.messageConsumer) {
        this.messageConsumer.dispose();
        this.messageConsumer = null;
      }
    });

    this.session.on(solace.SessionEventCode.RECONNECTING_NOTICE, () => {
      logger.info('Reconnecting to Solace broker');
    });

    this.session.on(solace.SessionEventCode.RECONNECTED_NOTICE, () => {
      logger.info('Reconnected to Solace broker');
    });

    this.session.on(solace.SessionEventCode.SUBSCRIPTION_ERROR, (sessionEvent) => {
      logger.error({ error: sessionEvent.toString() }, 'Subscription error');
      Sentry.captureException(new Error(`Subscription error: ${sessionEvent.toString()}`));
    });
  }

  /**
   * Subscribe to the NOTAM queue
   */
  private subscribeToQueue(queueName: string): void {
    if (!this.session) {
      logger.error('Cannot subscribe: session not initialized');
      return;
    }

    try {
      logger.info({ queueName }, 'Attempting to subscribe to queue');

      // Create queue descriptor
      const queueDescriptor = new solace.QueueDescriptor({
        name: queueName,
        type: solace.QueueType.QUEUE,
      });

      // Create message consumer
      this.messageConsumer = this.session.createMessageConsumer({
        queueDescriptor,
        acknowledgeMode: solace.MessageConsumerAcknowledgeMode.CLIENT,
        createIfMissing: false, // Queue already exists in SCDS
        windowSize: 10,
        activeIndicationEnabled: true,
      });

      // Set up consumer event listeners
      this.messageConsumer.on(solace.MessageConsumerEventName.UP, () => {
        logger.info({ queue: queueName }, 'Message consumer connected to queue');
      });

      this.messageConsumer.on(solace.MessageConsumerEventName.DOWN, () => {
        logger.warn('Message consumer disconnected from queue');
      });

      this.messageConsumer.on(solace.MessageConsumerEventName.CONNECT_FAILED_ERROR, () => {
        logger.error('Failed to connect message consumer to queue');
      });

      this.messageConsumer.on(solace.MessageConsumerEventName.MESSAGE, (message) => {
        this.handleMessage(message);
      });

      // Connect the consumer
      this.messageConsumer.connect();
    } catch (error) {
      logger.error({ error, queue: queueName }, 'Failed to subscribe to queue');
      Sentry.captureException(error);
    }
  }

  /**
   * Handle incoming message
   */
  private async handleMessage(message: solace.Message): Promise<void> {
    // Check circuit breaker before processing
    if (!this.circuitBreaker.isRequestAllowed()) {
      logger.warn(
        { circuitBreakerState: this.circuitBreaker.getState() },
        'Circuit breaker open, skipping message processing'
      );
      // Don't acknowledge - let message stay in queue for redelivery
      return;
    }

    try {
      // Try to get message payload in different formats
      let messageBody: string | null = null;

      // Try binary attachment first
      const binaryPayload = message.getBinaryAttachment();
      if (binaryPayload) {
        messageBody = binaryPayload.toString();
      }

      // Try XML content
      if (!messageBody) {
        const xmlContent = message.getXmlContent();
        if (xmlContent) {
          messageBody = xmlContent;
        }
      }

      // Try SDT container
      if (!messageBody) {
        const sdtContainer = message.getSdtContainer();
        if (sdtContainer) {
          messageBody = JSON.stringify(sdtContainer);
        }
      }

      if (!messageBody) {
        logger.debug(
          {
            type: message.getType(),
            destination: message.getDestination()?.getName(),
            userPropertyMap: message.getUserPropertyMap(),
          },
          'Received message with no extractable payload'
        );
        message.acknowledge();
        return;
      }

      logger.info({ messageLength: messageBody.length }, 'Received NOTAM message');

      // Process the message
      await this.processMessage(messageBody);

      // Record success for circuit breaker
      this.circuitBreaker.recordSuccess();

      // Acknowledge the message
      message.acknowledge();
    } catch (error) {
      logger.error({ error }, 'Error handling message');

      // Record failure for circuit breaker
      this.circuitBreaker.recordFailure(error);

      // Get circuit breaker state for logging
      const cbState = this.circuitBreaker.getState();

      // Capture exception with enhanced context
      Sentry.captureException(error, {
        tags: {
          error_type: 'message_processing',
          circuit_breaker_open: cbState.isOpen,
          circuit_breaker_failures: cbState.failures,
        },
        contexts: {
          database: {
            pool_stats: getPoolStats(),
          },
        },
      });

      // Negative acknowledge - message will be redelivered
      // Note: Solace automatically redelivers on client failure
    }
  }

  /**
   * Process incoming NOTAM message
   */
  private async processMessage(messageBody: string): Promise<void> {
    // Determine message format and parse
    let notam;
    if (messageBody.trim().startsWith('<')) {
      // XML/AIXM format
      notam = this.parser.parseAIXMMessage(messageBody);
    } else {
      // Text format
      notam = this.parser.parseTextNOTAM(messageBody);
    }

    if (!notam) {
      logger.debug(
        { messagePreview: messageBody.substring(0, 300) },
        'Failed to parse NOTAM message, skipping'
      );
      return;
    }

    // Save to database
    try {
      await this.notamModel.create(notam);
      logger.info({ notam_id: notam.notam_id }, 'NOTAM ingested successfully');
    } catch (error) {
      logger.error({ error, notam_id: notam.notam_id }, 'Failed to save NOTAM to database');
      throw error;
    }
  }

  /**
   * Stop the ingestion service gracefully
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      logger.warn('Ingestion service not running');
      return;
    }

    logger.info('Stopping NOTAM ingestion service');

    // Disconnect message consumer
    if (this.messageConsumer) {
      try {
        this.messageConsumer.disconnect();
        this.messageConsumer.dispose();
        this.messageConsumer = null;
        logger.info('Message consumer disconnected');
      } catch (error) {
        logger.error({ error }, 'Error disconnecting message consumer');
      }
    }

    // Disconnect session
    if (this.session) {
      try {
        this.session.disconnect();
        this.session.dispose();
        this.session = null;
        logger.info('Session disconnected');
      } catch (error) {
        logger.error({ error }, 'Error disconnecting session');
      }
    }

    this.isRunning = false;
    logger.info('NOTAM ingestion service stopped');
  }

  /**
   * Check if service is running
   */
  isServiceRunning(): boolean {
    return this.isRunning;
  }
}
