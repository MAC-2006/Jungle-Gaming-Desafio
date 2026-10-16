import { existsSync, writeFileSync } from 'node:fs';
import type { AppConfig } from '../../config/config';

export interface FaultInjector {
  /** Chamado depois do COMMIT e antes do ACK (DeleteMessage). */
  afterCommitBeforeAck(): void;
}

export class NoFaults implements FaultInjector {
  afterCommitBeforeAck(): void {
    /* produção: nada */
  }
}

/**
 * Só para testes: simula o worker morrendo entre o commit e o ack.
 * Dispara UMA vez (o arquivo marca que já disparou), então a instância reiniciada processa normalmente.
 * Exige ENABLE_FAULT_INJECTION=true — desligado por padrão e nunca habilitado em produção.
 */
export class CrashAfterCommitOnce implements FaultInjector {
  constructor(private readonly marker: string) {}
  afterCommitBeforeAck(): void {
    if (existsSync(this.marker)) return;
    writeFileSync(this.marker, 'crashed');
    process.exit(137);
  }
}

export function createFaultInjector(config: AppConfig): FaultInjector {
  if (config.ENABLE_FAULT_INJECTION && config.FAULT_CRASH_AFTER_COMMIT_FILE) {
    return new CrashAfterCommitOnce(config.FAULT_CRASH_AFTER_COMMIT_FILE);
  }
  return new NoFaults();
}
