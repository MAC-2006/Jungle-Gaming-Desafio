import { Controller, Get, Header } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { Public } from './auth';

/**
 * EXTRA fora do escopo do desafio: Home / painel de demonstração (uma página HTML estática, sem build).
 * Servida em `/` (Home) e em `/demo`. Só chama a API pública; não toca em domínio nem em casos de uso.
 * Desligue com ENABLE_DEMO=false.
 */
const PAGE = new URL('../../../demo/index.html', import.meta.url);

@Controller()
export class DemoController {
  @Public()
  @Get(['', 'demo'])
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  page(): string {
    return readFileSync(PAGE, 'utf8');
  }
}
