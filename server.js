import { createServer } from 'node:http';
import { createApplication } from './src/app.js';
import { loadConfig } from './src/config.js';

const config = loadConfig();
for (const warning of config.warnings) {
  console.warn(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: 'warn',
    message: warning,
  }));
}

const application = createApplication({ config });
const server = createServer(application.handler);
let shuttingDown = false;

server.on('clientError', (error, socket) => {
  console.warn(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: 'warn',
    event: 'client-error',
    error: error.code || error.message,
  }));
  if (socket.writable) {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  }
});

server.listen(config.port, config.host, () => {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: 'info',
    event: 'server-listening',
    host: config.host,
    port: config.port,
    origin: config.publicOrigin,
    databasePath: config.databasePath,
  }));
});

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: 'info',
    event: 'shutdown-started',
    signal,
  }));
  const forceTimer = setTimeout(() => {
    console.error(JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'error',
      event: 'shutdown-timeout',
    }));
    process.exitCode = 1;
    server.closeAllConnections?.();
  }, 10_000);
  forceTimer.unref();
  // Event streams are long-lived active connections. Close them before waiting
  // for the HTTP server, otherwise server.close() would wait until its timeout.
  application.broker.close();
  server.close(() => {
    clearTimeout(forceTimer);
    application.close();
    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'info',
      event: 'shutdown-complete',
    }));
  });
  server.closeIdleConnections?.();
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
