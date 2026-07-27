export const ORGANIZATION_ROLES = Object.freeze([
  'owner',
  'admin',
  'project_manager',
  'finance',
  'board',
  'auditor',
  'viewer',
]);

export const PROJECT_ROLES = Object.freeze([
  'project_manager',
  'contributor',
  'finance',
  'board',
  'auditor',
  'viewer',
]);

export const PERMISSIONS = Object.freeze({
  ORGANIZATION_READ: 'organization.read',
  ORGANIZATION_MANAGE: 'organization.manage',
  MEMBERS_READ: 'members.read',
  MEMBERS_MANAGE: 'members.manage',
  OWNERSHIP_MANAGE: 'ownership.manage',
  PROJECTS_CREATE: 'projects.create',
  PROJECT_READ: 'project.read',
  PROJECT_MANAGE: 'project.manage',
  PROJECT_ARCHIVE: 'project.archive',
  PROJECT_MEMBERS_MANAGE: 'project_members.manage',
  PROJECT_WORK_WRITE: 'project_work.write',
  PROPOSALS_READ: 'proposals.read_sensitive',
  PROPOSALS_MANAGE: 'proposals.manage',
  STAKEHOLDERS_READ: 'stakeholders.read_sensitive',
  STAKEHOLDERS_MANAGE: 'stakeholders.manage',
  CAPITAL_READ: 'capital.read',
  CAPITAL_MANAGE: 'capital.manage',
  FINANCE_READ: 'finance.read',
  FINANCE_MANAGE: 'finance.manage',
  GOALS_MANAGE: 'goals.manage',
  GOVERNANCE_READ: 'governance.read',
  GOVERNANCE_MANAGE: 'governance.manage',
  COMPLIANCE_READ: 'compliance.read',
  COMPLIANCE_MANAGE: 'compliance.manage',
  CONTRACTS_READ: 'contracts.read',
  CONTRACTS_MANAGE: 'contracts.manage',
  AUDIT_READ: 'audit.read',
});

const P = PERMISSIONS;
const ALL = '*';

const ORGANIZATION_ROLE_PERMISSIONS = Object.freeze({
  owner: [ALL],
  admin: [
    P.ORGANIZATION_READ,
    P.ORGANIZATION_MANAGE,
    P.MEMBERS_READ,
    P.MEMBERS_MANAGE,
    P.PROJECTS_CREATE,
    P.PROJECT_READ,
    P.PROJECT_MANAGE,
    P.PROJECT_ARCHIVE,
    P.PROJECT_MEMBERS_MANAGE,
    P.PROJECT_WORK_WRITE,
    P.PROPOSALS_READ,
    P.PROPOSALS_MANAGE,
    P.STAKEHOLDERS_READ,
    P.STAKEHOLDERS_MANAGE,
    P.CAPITAL_READ,
    P.CAPITAL_MANAGE,
    P.FINANCE_READ,
    P.FINANCE_MANAGE,
    P.GOALS_MANAGE,
    P.GOVERNANCE_READ,
    P.GOVERNANCE_MANAGE,
    P.COMPLIANCE_READ,
    P.COMPLIANCE_MANAGE,
    P.CONTRACTS_READ,
    P.CONTRACTS_MANAGE,
    P.AUDIT_READ,
  ],
  project_manager: [
    P.ORGANIZATION_READ,
    P.MEMBERS_READ,
    P.PROJECTS_CREATE,
    P.PROJECT_READ,
    P.PROJECT_MANAGE,
    P.PROJECT_MEMBERS_MANAGE,
    P.PROJECT_WORK_WRITE,
    P.PROPOSALS_READ,
    P.PROPOSALS_MANAGE,
    P.STAKEHOLDERS_READ,
    P.STAKEHOLDERS_MANAGE,
    P.CAPITAL_READ,
    P.FINANCE_READ,
    P.GOALS_MANAGE,
    P.GOVERNANCE_READ,
  ],
  finance: [
    P.ORGANIZATION_READ,
    P.MEMBERS_READ,
    P.PROJECT_READ,
    P.STAKEHOLDERS_READ,
    P.CAPITAL_READ,
    P.CAPITAL_MANAGE,
    P.FINANCE_READ,
    P.FINANCE_MANAGE,
    P.GOVERNANCE_READ,
    P.COMPLIANCE_READ,
    P.CONTRACTS_READ,
  ],
  board: [
    P.ORGANIZATION_READ,
    P.MEMBERS_READ,
    P.PROJECT_READ,
    P.STAKEHOLDERS_READ,
    P.CAPITAL_READ,
    P.FINANCE_READ,
    P.GOVERNANCE_READ,
    P.GOVERNANCE_MANAGE,
    P.COMPLIANCE_READ,
    P.COMPLIANCE_MANAGE,
    P.CONTRACTS_READ,
    P.CONTRACTS_MANAGE,
    P.AUDIT_READ,
  ],
  auditor: [
    P.ORGANIZATION_READ,
    P.MEMBERS_READ,
    P.PROJECT_READ,
    P.PROPOSALS_READ,
    P.STAKEHOLDERS_READ,
    P.CAPITAL_READ,
    P.FINANCE_READ,
    P.GOVERNANCE_READ,
    P.COMPLIANCE_READ,
    P.CONTRACTS_READ,
    P.AUDIT_READ,
  ],
  // A viewer membership grants organization metadata only. Project access
  // requires an explicit project_memberships row, preventing an invitation to
  // one project from exposing every project in the organization.
  viewer: [
    P.ORGANIZATION_READ,
  ],
});

const PROJECT_ROLE_PERMISSIONS = Object.freeze({
  project_manager: [
    P.PROJECT_READ,
    P.PROJECT_MANAGE,
    P.PROJECT_MEMBERS_MANAGE,
    P.PROJECT_WORK_WRITE,
    P.PROPOSALS_READ,
    P.PROPOSALS_MANAGE,
    P.STAKEHOLDERS_READ,
    P.STAKEHOLDERS_MANAGE,
    P.CAPITAL_READ,
    P.FINANCE_READ,
    P.GOALS_MANAGE,
    P.GOVERNANCE_READ,
    P.COMPLIANCE_READ,
    P.CONTRACTS_READ,
  ],
  contributor: [
    P.PROJECT_READ,
    P.PROJECT_WORK_WRITE,
    P.GOVERNANCE_READ,
  ],
  finance: [
    P.PROJECT_READ,
    P.STAKEHOLDERS_READ,
    P.CAPITAL_READ,
    P.CAPITAL_MANAGE,
    P.FINANCE_READ,
    P.FINANCE_MANAGE,
    P.GOVERNANCE_READ,
    P.COMPLIANCE_READ,
    P.CONTRACTS_READ,
  ],
  board: [
    P.PROJECT_READ,
    P.STAKEHOLDERS_READ,
    P.CAPITAL_READ,
    P.FINANCE_READ,
    P.GOVERNANCE_READ,
    P.GOVERNANCE_MANAGE,
    P.COMPLIANCE_READ,
    P.COMPLIANCE_MANAGE,
    P.CONTRACTS_READ,
    P.CONTRACTS_MANAGE,
    P.AUDIT_READ,
  ],
  auditor: [
    P.PROJECT_READ,
    P.PROPOSALS_READ,
    P.STAKEHOLDERS_READ,
    P.CAPITAL_READ,
    P.FINANCE_READ,
    P.GOVERNANCE_READ,
    P.COMPLIANCE_READ,
    P.CONTRACTS_READ,
    P.AUDIT_READ,
  ],
  viewer: [
    P.PROJECT_READ,
    P.GOVERNANCE_READ,
  ],
});

const ORGANIZATION_WIDE_PROJECT_ROLES = new Set([
  'owner',
  'admin',
  'project_manager',
  'finance',
  'board',
  'auditor',
]);

export function isOrganizationRole(value) {
  return ORGANIZATION_ROLES.includes(value);
}

export function isProjectRole(value) {
  return PROJECT_ROLES.includes(value);
}

export function organizationRoleGrantsAllProjects(role) {
  return ORGANIZATION_WIDE_PROJECT_ROLES.has(role);
}

export function permissionsForRoles(organizationRole, projectRole = null) {
  const permissions = new Set();
  for (const permission of ORGANIZATION_ROLE_PERMISSIONS[organizationRole] || []) {
    permissions.add(permission);
  }
  for (const permission of PROJECT_ROLE_PERMISSIONS[projectRole] || []) {
    permissions.add(permission);
  }
  return permissions;
}

export function hasPermission(permissionsOrAuthorization, permission) {
  const permissions = permissionsOrAuthorization instanceof Set
    ? permissionsOrAuthorization
    : permissionsOrAuthorization?.permissions;
  return Boolean(
    permissions &&
    (permissions.has(ALL) || permissions.has(permission)),
  );
}

export function serializePermissions(permissions) {
  if (!permissions) return [];
  if (permissions.has(ALL)) return [ALL];
  return [...permissions].sort();
}

export const rbacInternals = Object.freeze({
  ALL,
  ORGANIZATION_ROLE_PERMISSIONS,
  PROJECT_ROLE_PERMISSIONS,
});
