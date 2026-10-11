// JWT 解码与身份提取（tenant / enterprise / user）
export interface JwtPayload {
  iss?: string
  tenant_id?: string
  tenantId?: string
  enterprise_id?: string
  enterpriseId?: string
  ent_id?: string
  entId?: string
  user_id?: string
  userId?: string
  uid?: string
  sub?: string
  realm_access?: { roles?: string[] }
  resource_access?: { account?: { roles?: string[] } }
}

export function decodeJwtPayload(token: string): JwtPayload | null {
  try {
    const [_header, payload] = token.split('.')
    if (!payload) return null
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as JwtPayload
  } catch {
    return null
  }
}

/** 从 JWT 提取的身份三元组（用于 OAuth 模式的租户/企业/用户头） */
export interface Identity {
  tenantId: string
  enterpriseId: string
  userId: string
}

/** 身份提取的配置覆盖值（环境变量优先于 JWT 声明）。 */
export interface IdentityOverrides {
  tenantId?: string
  enterpriseId?: string
  userId?: string
}

/** tenant：cfg 短路 > tenant_id/tenantId > iss 末尾 sso-（$ 锚）。 */
function pickTenantId(payload: JwtPayload, cfg?: IdentityOverrides): string {
  if (cfg?.tenantId) return cfg.tenantId
  if (payload.tenant_id) return payload.tenant_id
  if (payload.tenantId) return payload.tenantId
  const [_all, tenant] = (payload.iss ?? '').match(/realms\/sso-([^/]+)$/) ?? []
  return tenant ?? ''
}

/** enterprise：cfg 短路 > roles 中 group-admin:* > enterprise_id 变体。 */
function pickEnterpriseId(payload: JwtPayload, cfg?: IdentityOverrides): string {
  if (cfg?.enterpriseId) return cfg.enterpriseId
  const roles = payload.realm_access?.roles ?? payload.resource_access?.account?.roles
  for (const r of roles ?? []) {
    const [_all, adminEnterpriseId] = r.match(/group-admin:([A-Za-z0-9-]+)/) ?? []
    if (adminEnterpriseId) return adminEnterpriseId
  }
  return payload.enterprise_id ?? payload.enterpriseId ?? payload.ent_id ?? payload.entId ?? ''
}

/** user：cfg 短路 > user_id 变体。 */
function pickUserId(payload: JwtPayload, cfg?: IdentityOverrides): string {
  if (cfg?.userId) return cfg.userId
  return payload.user_id ?? payload.userId ?? payload.uid ?? payload.sub ?? ''
}

export function resolveIdentity(payload: JwtPayload | null, cfg?: IdentityOverrides): Identity {
  if (!payload) {
    return {
      tenantId: cfg?.tenantId ?? '',
      enterpriseId: cfg?.enterpriseId ?? '',
      userId: cfg?.userId ?? ''
    }
  }
  return {
    tenantId: pickTenantId(payload, cfg),
    enterpriseId: pickEnterpriseId(payload, cfg),
    userId: pickUserId(payload, cfg)
  }
}
