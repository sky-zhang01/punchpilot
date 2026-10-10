import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import OAuthConfigCard from './OAuthConfigCard';

const apiMocks = vi.hoisted(() => ({
  getEmployeeInfo: vi.fn(),
  getOAuthAuthorizeUrl: vi.fn(),
  getOAuthStatus: vi.fn(),
}));

const dispatchMock = vi.hoisted(() => vi.fn());
const fetchConfigMock = vi.hoisted(() => vi.fn(() => ({ type: 'config/fetchConfig' })));
const notifyMocks = vi.hoisted(() => ({
  notifyError: vi.fn(),
  notifySuccess: vi.fn(),
  notifyWarning: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('../../api', () => ({ default: apiMocks }));
vi.mock('../../store/configSlice', () => ({ fetchConfig: fetchConfigMock }));
vi.mock('../../store/hooks', () => ({
  useAppDispatch: () => dispatchMock,
  useAppSelector: (selector: (state: any) => unknown) => selector({
    config: { oauthConfigured: false },
  }),
}));
vi.mock('../../utils/notify', () => notifyMocks);

vi.mock('antd', () => {
  const Form = ({ children }: any) => <form>{children}</form>;
  Form.Item = ({ children, label }: any) => <label>{label}{children}</label>;
  const Input = ({ onChange, placeholder, value }: any) => (
    <input placeholder={placeholder} value={value} onChange={onChange} />
  );
  Input.Password = Input;
  const Descriptions = ({ children }: any) => <div>{children}</div>;
  Descriptions.Item = ({ children, label }: any) => <div>{label}{children}</div>;
  return {
    Alert: ({ message }: any) => <div role="alert">{message}</div>,
    Button: ({ children, disabled, loading, onClick }: any) => (
      <button type="button" disabled={disabled || loading} onClick={onClick}>{children}</button>
    ),
    Card: ({ children }: any) => <section>{children}</section>,
    Descriptions,
    Form,
    Input,
    Select: () => <select />,
    Space: ({ children }: any) => <div>{children}</div>,
    Steps: () => <div />,
    Tag: ({ children }: any) => <span>{children}</span>,
    Typography: {
      Text: ({ children }: any) => <span>{children}</span>,
      Title: ({ children }: any) => <h2>{children}</h2>,
    },
  };
});

describe('OAuthConfigCard authorization popup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.getOAuthStatus.mockResolvedValue({
      data: { authorization_version: '7', configured: false, token_valid: false },
    });
    apiMocks.getEmployeeInfo.mockResolvedValue({ data: {} });
    apiMocks.getOAuthAuthorizeUrl.mockResolvedValue({
      data: { url: 'https://accounts.example.test/oauth' },
    });
  });

  it('does not create server-side authorization state when the popup is blocked', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    render(<OAuthConfigCard />);
    await waitFor(() => expect(apiMocks.getOAuthStatus).toHaveBeenCalled());
    apiMocks.getOAuthStatus.mockClear();

    fireEvent.click(screen.getByRole('button', { name: 'settings.authorizeWithFreee' }));

    expect(apiMocks.getOAuthAuthorizeUrl).not.toHaveBeenCalled();
    expect(apiMocks.getOAuthStatus).not.toHaveBeenCalled();
    expect(notifyMocks.notifyWarning).toHaveBeenCalledWith('common.error');
  });

  it('opens synchronously before requesting the authorization URL', async () => {
    const order: string[] = [];
    const popup = {
      closed: false,
      close: vi.fn(),
      location: { href: '' },
    } as unknown as Window;
    vi.spyOn(window, 'open').mockImplementation(() => {
      order.push('open');
      return popup;
    });
    render(<OAuthConfigCard />);
    await waitFor(() => expect(apiMocks.getOAuthStatus).toHaveBeenCalled());
    apiMocks.getOAuthStatus.mockImplementation(async () => {
      order.push('status');
      return { data: { authorization_version: '7' } };
    });
    apiMocks.getOAuthAuthorizeUrl.mockImplementation(async () => {
      order.push('authorize');
      return { data: { url: 'https://accounts.example.test/oauth' } };
    });

    fireEvent.click(screen.getByRole('button', { name: 'settings.authorizeWithFreee' }));

    await waitFor(() => expect(apiMocks.getOAuthAuthorizeUrl).toHaveBeenCalledTimes(1));
    expect(order).toEqual(['open', 'status', 'authorize']);
    expect(popup.location.href).toBe('https://accounts.example.test/oauth');
  });
});
