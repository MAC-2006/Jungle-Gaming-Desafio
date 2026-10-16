import { DynamicModule, Inject, Module, OnApplicationBootstrap, BeforeApplicationShutdown, OnApplicationShutdown, Injectable } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import type { Services } from './composition';
import type { Runtime } from './runtime';
import { AuthGuard } from './presentation/http/auth';
import { DemoController } from './presentation/http/demo.controller';
import { HealthController, WageringController, WalletsController } from './presentation/http/controllers';
import { AllExceptionsFilter } from './presentation/http/http-errors';
import { ObservabilityInterceptor } from './presentation/http/observability.interceptor';
import { RUNTIME, SERVICES } from './presentation/tokens';

/** Ciclo de vida: inicia consumer/workers no bootstrap; no SIGTERM conclui o que está em andamento e fecha o banco. */
@Injectable()
class LifecycleService implements OnApplicationBootstrap, BeforeApplicationShutdown, OnApplicationShutdown {
  constructor(
    @Inject(SERVICES) private readonly services: Services,
    @Inject(RUNTIME) private readonly runtime: Runtime,
  ) {}

  onApplicationBootstrap(): void {
    this.runtime.start();
    this.services.logger.info('app.started', { workers: this.runtime.workers.length, consumer: Boolean(this.runtime.consumer) });
  }

  async beforeApplicationShutdown(signal?: string): Promise<void> {
    this.services.logger.info('app.shutting_down', { signal });
    await this.runtime.stop();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.services.orm.close();
    this.services.logger.info('app.stopped');
  }
}

@Module({})
export class AppModule {
  static register(services: Services, runtime: Runtime): DynamicModule {
    return {
      module: AppModule,
      controllers: [
        WalletsController,
        WageringController,
        HealthController,
        ...(services.config.ENABLE_DEMO ? [DemoController] : []),
      ],
      providers: [
        { provide: SERVICES, useValue: services },
        { provide: RUNTIME, useValue: runtime },
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_INTERCEPTOR, useClass: ObservabilityInterceptor },
        { provide: APP_FILTER, useValue: new AllExceptionsFilter(services.logger) },
        LifecycleService,
      ],
    };
  }
}
