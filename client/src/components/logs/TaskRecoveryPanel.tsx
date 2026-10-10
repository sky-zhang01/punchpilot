import { useEffect, useReducer, useState, useSyncExternalStore } from 'react';
import { Alert, Button, Card, Space, Tag, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import { getIdentityEpoch, subscribeIdentity } from '../../http';
import { forgetTask, getTask, getTaskReferences, getTaskSnapshots, resumeTask, subscribeTasks, type TaskDTO } from '../../tasks';

export function TaskResultSummary({ task }: { task: TaskDTO }) {
  const { t } = useTranslation();
  return <Space orientation="vertical" style={{ width: '100%' }}>
    <Alert type={task.success ? 'success' : task.status === 'running' ? 'info' : 'warning'} showIcon
      message={t(`tasks.${task.status}`)}
      description={t('tasks.counts', { succeeded: task.succeeded, failed: task.failed, unknown: task.unknown, unprocessed: task.total === null ? t('tasks.totalUnknown') : task.total - task.processed })} />
    {(task.unknown > 0 || task.total === null) && <Alert type="warning" showIcon message={t('tasks.verifyUnknown')} />}
    {task.error && <Typography.Text type="danger">{task.error}</Typography.Text>}
    <ul style={{ margin: 0, paddingInlineStart: 20 }}>
      {task.results.map((result, index) => <li key={result.date || `${result.type}:${result.id}:${index}`}>
        <Typography.Text>{result.date || `${result.type || ''}:${result.id ?? ''}`}</Typography.Text>{' '}
        <Tag color={result.unknown ? 'warning' : result.success ? 'success' : 'error'}>
          {t(result.unknown ? 'status.unknown' : result.success ? 'status.success' : 'status.failure')}
        </Tag>
        {result.error || result.reason || ''}
      </li>)}
    </ul>
  </Space>;
}

export default function TaskRecoveryPanel() {
  const { t } = useTranslation();
  const epoch = useSyncExternalStore(subscribeIdentity, getIdentityEpoch);
  const [, refresh] = useReducer(value => value + 1, 0);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  useEffect(() => subscribeTasks(refresh), []);
  useEffect(() => {
    let active = true;
    setErrors({}); setBusy({}); setHidden(new Set());
    for (const reference of getTaskReferences()) {
      getTask(reference.taskId).catch((error) => {
        if (!active) return;
        if (error?.response?.status === 404) setHidden(value => new Set([...value, reference.taskId]));
        else setErrors(value => ({ ...value, [reference.taskId]: 'TASK_QUERY_FAILED' }));
      });
    }
    return () => { active = false; };
  }, [epoch]);

  const resume = async (taskId: string) => {
    const startedEpoch = getIdentityEpoch();
    setBusy(value => ({ ...value, [taskId]: true }));
    setErrors(value => ({ ...value, [taskId]: '' }));
    try { await resumeTask(taskId); }
    catch {
      if (startedEpoch === getIdentityEpoch()) setErrors(value => ({ ...value, [taskId]: 'TASK_QUERY_FAILED' }));
    } finally {
      if (startedEpoch === getIdentityEpoch()) setBusy(value => ({ ...value, [taskId]: false }));
    }
  };
  const references = getTaskReferences().filter(reference => !hidden.has(reference.taskId));
  const tasks = getTaskSnapshots();
  if (!references.length) return null;
  return <Card size="small" title={t('tasks.title')}>
    <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
      {references.map(reference => {
        const task = tasks.find(value => value.taskId === reference.taskId);
        return <section key={reference.taskId} aria-label={t(`tasks.${reference.taskType}`)} style={{ width: '100%' }}>
          <Typography.Text strong>{t(`tasks.${reference.taskType}`)}</Typography.Text>{' '}
          <Typography.Text code>{reference.taskId}</Typography.Text>
          {task && <TaskResultSummary task={task} />}
          {errors[reference.taskId] && <Alert type="warning" message={t('tasks.queryPaused')} />}
          <Space style={{ marginTop: 8 }}>
            <Button size="small" loading={busy[reference.taskId]} onClick={() => resume(reference.taskId)}>{t('tasks.resume')}</Button>
            <Button size="small" disabled={busy[reference.taskId] || task?.status === 'running'} onClick={() => forgetTask(reference.taskId)}>{t('tasks.dismiss')}</Button>
          </Space>
        </section>;
      })}
    </Space>
  </Card>;
}
