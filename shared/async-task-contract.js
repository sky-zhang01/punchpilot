export const TASK_TYPES = Object.freeze(/** @type {const} */ ([
  'batch_punch', 'batch_leave', 'batch_withdraw', 'batch_approve',
]));
export const TASK_STATUSES = Object.freeze(/** @type {const} */ ([
  'running', 'completed', 'failed', 'interrupted',
]));

/** @param {unknown} value @returns {value is (typeof TASK_TYPES)[number]} */
export function isTaskType(value) {
  return typeof value === 'string' && TASK_TYPES.some(type => type === value);
}

/** @param {unknown} value @returns {value is (typeof TASK_STATUSES)[number]} */
export function isTaskStatus(value) {
  return typeof value === 'string' && TASK_STATUSES.some(status => status === value);
}
