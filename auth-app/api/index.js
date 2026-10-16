import { createApp } from '../server.js';
import { databaseErrorMessage } from '../database.js';

export function createHandler(createApplication = createApp) {
  let application;
  return async function handler(request, response) {
    try {
      application ||= Promise.resolve().then(() => createApplication()).catch((error) => {
        application = undefined;
        throw error;
      });
      const app = await application;
      return app(request, response);
    } catch (error) {
      console.error('Application initialization failed:', databaseErrorMessage(error));
      response.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ message: 'The application is temporarily unavailable. Please try again later.' }));
    }
  };
}

export default createHandler();