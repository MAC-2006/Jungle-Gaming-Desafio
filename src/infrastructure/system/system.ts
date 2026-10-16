import { v7 as uuidv7 } from 'uuid';
import type { Clock, IdGenerator } from '../../application/ports/ports';

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export class UuidV7Generator implements IdGenerator {
  next(): string {
    return uuidv7();
  }
}

/** Relógio controlável para testes de backoff/TTL sem dormir. */
export class FakeClock implements Clock {
  constructor(private current: Date = new Date()) {}
  now(): Date {
    return new Date(this.current.getTime());
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
  set(date: Date): void {
    this.current = date;
  }
}
