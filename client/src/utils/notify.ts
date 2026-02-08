import { notification } from 'antd';

/**
 * Quick success toast - green background
 */
export function notifySuccess(msg: string) {
  notification.success({
    message: msg,
    duration: 3,
    style: {
      background: '#f6ffed',
      border: '1px solid #b7eb8f',
    },
  });
}

/**
 * Info toast - blue background
 */
export function notifyInfo(msg: string) {
  notification.info({
    message: msg,
    duration: 3,
    style: {
      background: '#e6f4ff',
      border: '1px solid #91caff',
    },
  });
}

/**
 * Warning notification - yellow/orange background
 */
export function notifyWarning(msg: string) {
  notification.warning({
    message: msg,
    duration: 5,
    style: {
      background: '#fffbe6',
      border: '1px solid #ffe58f',
    },
  });
}

/**
 * Error notification - red background, auto-dismiss 8s
 */
export function notifyError(msg: string) {
  notification.error({
    message: 'Error',
    description: msg,
    duration: 8,
    style: {
      background: '#fff2f0',
      border: '1px solid #ffccc7',
    },
  });
}
