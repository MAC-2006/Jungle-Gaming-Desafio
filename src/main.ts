import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { buildServices } from './composition';
import { loadConfig } from './config/config';
import { buildRuntime } from './runtime';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const services = await buildServices(config);
  const runtime = await buildRuntime(services);

  const app = await NestFactory.create(AppModule.register(services, runtime), { logger: false });

  // Desligamento gracioso explícito: para de aceitar HTTP, o consumer conclui o lote em andamento (ack só após
  // commit), workers terminam a iteração, e só então o pool do banco fecha. Sai com código 0 (não re-sinaliza).
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    const force = setTimeout(() => {
      console.error(JSON.stringify({ level: 'fatal', event: 'shutdown_timeout', signal }));
      process.exit(1);
    }, 25_000);
    force.unref();
    app
      .close()
      .then(() => process.exit(0))
      .catch((error) => {
        console.error(JSON.stringify({ level: 'fatal', event: 'shutdown_failed', error: error instanceof Error ? error.message : String(error) }));
        process.exit(1);
      });
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
  await app.listen(config.PORT, '0.0.0.0');
  services.logger.info('http.listening', { port: config.PORT });
}

bootstrap().catch((error) => {
  console.error(JSON.stringify({ level: 'fatal', event: 'bootstrap_failed', error: error instanceof Error ? error.message : String(error) }));
  process.exit(1);
});
