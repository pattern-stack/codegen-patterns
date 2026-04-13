import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  await app.listen(3000);
  console.log('NestJS scaffold listening on http://localhost:3000');
}

bootstrap().catch((err) => {
  console.error('Failed to start scaffold app:', err);
  process.exit(1);
});
