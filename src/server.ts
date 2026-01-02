import express, { Express } from 'express';
import * as Sentry from '@sentry/node';
import { logger } from './config/logger';
import { errorHandler } from './middleware/error-handler';
import { metricsMiddleware } from './middleware/metrics';
import healthRouter from './routes/health';
import metricsRouter from './routes/metrics';
import notamsRouter from './routes/notams';

export const createServer = (): Express => {
  const app = express();

  // Initialize Sentry if DSN is provided
  if (process.env.SENTRY_DSN) {
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.NODE_ENV || 'development',
      tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
      integrations: [Sentry.expressIntegration()],
    });
  }

  // Body parsing middleware
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Request logging
  app.use((req, _res, next) => {
    logger.debug(
      {
        method: req.method,
        path: req.path,
        query: req.query,
      },
      'Incoming request'
    );
    next();
  });

  // Metrics middleware (must be before routes to track request durations)
  app.use(metricsMiddleware);

  // Routes
  app.use('/', metricsRouter);
  app.use('/', healthRouter);
  app.use('/api', notamsRouter);

  // Sentry error handler must be before other error handlers
  if (process.env.SENTRY_DSN) {
    Sentry.setupExpressErrorHandler(app);
  }

  // Error handling middleware (must be last)
  app.use(errorHandler);

  return app;
};
