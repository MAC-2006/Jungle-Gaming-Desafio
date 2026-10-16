import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

export const IS_PUBLIC = 'isPublic';
/** Health checks e métricas ficam abertos (seção 2 do desafio). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/**
 * PONTO DE EXTENSÃO de autenticação — deliberadamente no-op (a seção 2 do desafio aceita não implementar).
 * Desenho adotado se fosse implementado: Keycloak/Zitadel como IdP OIDC; este guard validaria o JWT
 * (assinatura via JWKS, `iss`, `aud`, `exp`) e mapearia o claim de provedor para um `ProviderIdentity`, que
 * então seria comparado com `providerId` do corpo (um provedor só opera em nome de si mesmo). Ver ARCHITECTURE.md.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()]);
    if (isPublic) return true;
    return true; // no-op
  }
}
