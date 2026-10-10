import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import BrowserAccountCard from './BrowserAccountCard';

const apiMocks = vi.hoisted(() => ({
  getAccount: vi.fn(),
  verifyWebCredentials: vi.fn(),
}));

const actionMocks = vi.hoisted(() => ({
  clearAccount: vi.fn(() => ({ type: 'config/clearAccount' })),
  fetchConfig: vi.fn(() => ({ type: 'config/fetchConfig' })),
  saveAccount: vi.fn((payload: any) => ({ type: 'config/saveAccount', payload })),
}));

const dispatchMock = vi.hoisted(() => vi.fn());

const notifyMocks = vi.hoisted(() => ({
  notifyError: vi.fn(),
  notifySuccess: vi.fn(),
  notifyWarning: vi.fn(),
}));

const state = {
  config: {
    freeeConfigured: false,
    freeeUsername: '',
    webIdentityVerified: false,
  },
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('../../api', () => ({
  default: apiMocks,
}));

vi.mock('../../store/configSlice', () => ({
  clearAccount: actionMocks.clearAccount,
  fetchConfig: actionMocks.fetchConfig,
  saveAccount: actionMocks.saveAccount,
}));

vi.mock('../../store/hooks', () => ({
  useAppDispatch: () => dispatchMock,
  useAppSelector: (selector: (value: typeof state) => unknown) => selector(state),
}));

vi.mock('../../utils/notify', () => ({
  notifyError: notifyMocks.notifyError,
  notifySuccess: notifyMocks.notifySuccess,
  notifyWarning: notifyMocks.notifyWarning,
}));

vi.mock('antd', () => {
  const Form = ({ children }: any) => <form>{children}</form>;
  Form.Item = ({ children, label }: any) => <label>{label}{children}</label>;
  const Input = ({ onChange, placeholder, value }: any) => (
    <input placeholder={placeholder} value={value} onChange={onChange} />
  );
  Input.Password = ({ onChange, placeholder, value }: any) => (
    <input type="password" placeholder={placeholder} value={value} onChange={onChange} />
  );
  return {
    Alert: ({ message }: any) => <div role="alert">{message}</div>,
    Button: ({ children, disabled, loading, onClick }: any) => (
      <button type="button" disabled={disabled || loading} onClick={onClick}>{children}</button>
    ),
    Card: ({ children }: any) => <section>{children}</section>,
    Form,
    Input,
    Space: ({ children }: any) => <div>{children}</div>,
    Tag: ({ children }: any) => <span>{children}</span>,
    Typography: {
      Text: ({ children }: any) => <span>{children}</span>,
      Title: ({ children }: any) => <h2>{children}</h2>,
    },
  };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function fillCredentials(companyName: string) {
  fireEvent.change(screen.getByPlaceholderText('settings.usernamePlaceholder'), {
    target: { value: '  test-user  ' },
  });
  fireEvent.change(screen.getByPlaceholderText('settings.passwordPlaceholder'), {
    target: { value: 'example-password' },
  });
  fireEvent.change(screen.getByPlaceholderText('settings.webCompanyPlaceholder'), {
    target: { value: companyName },
  });
}

describe('BrowserAccountCard credential boundaries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.config.freeeConfigured = false;
    state.config.freeeUsername = '';
    state.config.webIdentityVerified = false;
    apiMocks.getAccount.mockResolvedValue({ data: {} });
    apiMocks.verifyWebCredentials.mockResolvedValue({ data: { valid: true } });
  });

  it('rejects a blank company name before dispatching credentials', async () => {
    render(<BrowserAccountCard />);
    fillCredentials('   ');

    fireEvent.click(screen.getByRole('button', { name: 'settings.saveCredentials' }));

    expect(notifyMocks.notifyWarning).toHaveBeenCalledWith('settings.enterWebCompany');
    expect(actionMocks.saveAccount).not.toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('trims account identity and verifies only after a successful save', async () => {
    const saved = deferred<{ freee_configured: boolean }>();
    dispatchMock.mockReturnValue({ unwrap: () => saved.promise });
    render(<BrowserAccountCard />);
    fillCredentials('  Example Company  ');

    fireEvent.click(screen.getByRole('button', { name: 'settings.saveCredentials' }));

    expect(actionMocks.saveAccount).toHaveBeenCalledWith({
      username: 'test-user',
      password: 'example-password',
      companyName: 'Example Company',
    });
    expect(apiMocks.verifyWebCredentials).not.toHaveBeenCalled();

    saved.resolve({ freee_configured: true });
    await waitFor(() => expect(apiMocks.verifyWebCredentials).toHaveBeenCalledTimes(1));
    expect(notifyMocks.notifySuccess).toHaveBeenCalledWith('settings.credsSaved');
    expect(actionMocks.fetchConfig).toHaveBeenCalledTimes(1);
  });

  it('allows environment-backed credentials to establish the employee binding', async () => {
    apiMocks.getAccount.mockResolvedValue({
      data: {
        has_env_credentials: true,
        env_username: 'syn***',
        freee_company_name: 'Example Company',
      },
    });
    render(<BrowserAccountCard />);

    const verify = await screen.findByRole('button', { name: 'settings.verify' });
    expect((verify as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(verify);

    await waitFor(() => expect(apiMocks.verifyWebCredentials).toHaveBeenCalledTimes(1));
    expect(actionMocks.fetchConfig).toHaveBeenCalledTimes(1);
  });

  it('retains account fields and reports failure when clearing is rejected', async () => {
    state.config.freeeConfigured = true;
    dispatchMock.mockReturnValue({ unwrap: () => Promise.reject(new Error('cannot clear')) });
    render(<BrowserAccountCard />);
    fillCredentials('Example Company');
    fireEvent.click(screen.getByRole('button', { name: 'settings.clear' }));
    await waitFor(() => expect(notifyMocks.notifyError).toHaveBeenCalled());
    expect(notifyMocks.notifySuccess).not.toHaveBeenCalled();
    expect((screen.getByPlaceholderText('settings.webCompanyPlaceholder') as HTMLInputElement).value).toBe('Example Company');
  });
});
