export interface SolaceConfig {
  url: string;
  vpnName: string;
  username: string;
  password: string;
  queueName: string;
}

export const getSolaceConfig = (): SolaceConfig => {
  const host = process.env.JMS_HOST || 'localhost';
  const port = process.env.JMS_PORT || '55443';
  const url = `tcps://${host}:${port}`;

  // Strip /queue/ or /topic/ prefix from destination if present
  const destination = process.env.JMS_DESTINATION || '';
  const queueName = destination.replace(/^\/(queue|topic)\//, '');

  const config: SolaceConfig = {
    url,
    vpnName: process.env.JMS_VHOST || 'AIM_FNS',
    username: process.env.JMS_USERNAME || '',
    password: process.env.JMS_PASSWORD || '',
    queueName,
  };

  if (!config.username || !config.password) {
    throw new Error(
      'Solace credentials not configured. Set JMS_USERNAME and JMS_PASSWORD environment variables.'
    );
  }

  if (!config.queueName) {
    throw new Error('JMS_DESTINATION not configured. Set the queue name from SCDS.');
  }

  return config;
};
