const { errorResponse } = require('../utils/helpers');

const ROLE_PERMISSIONS = {
  SUPER_ADMIN: ['*'],
  FINANCE_OFFICER: ['payments:*', 'invoices:*', 'reports:read', 'clients:read'],
  SUPPORT_AGENT: ['tickets:*', 'clients:read', 'operators:read'],
  SALES_MANAGER: ['clients:*', 'subscriptions:*', 'licenses:create', 'payments:create', 'reports:read'],
};

function hasPermission(role, required) {
  const perms = ROLE_PERMISSIONS[role] || [];
  if (perms.includes('*')) return true;
  const [resource, action] = required.split(':');
  return perms.includes(required) || perms.includes(`${resource}:*`);
}

function authorize(...permissions) {
  return (req, res, next) => {
    if (!req.admin) return errorResponse(res, 'Unauthorized', 401);
    const allowed = permissions.every((perm) => hasPermission(req.admin.role, perm));
    if (!allowed) return errorResponse(res, 'Forbidden: insufficient permissions', 403);
    next();
  };
}

module.exports = { authorize, hasPermission };
