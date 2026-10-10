import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  compareSync: vi.fn(),
  getUserByUsername: vi.fn(),
  hashSync: vi.fn(() => 'dummy-password-hash'),
}));

vi.mock('bcryptjs', () => ({
  default: {
    compareSync: mocks.compareSync,
    hashSync: mocks.hashSync,
  },
}));

vi.mock('../server/db.js', () => ({
  cleanExpiredSessions: vi.fn(),
  clearInitialAdminPassword: vi.fn(),
  createSession: vi.fn(),
  deleteAllUserSessions: vi.fn(),
  deleteSession: vi.fn(),
  getSession: vi.fn(),
  getUserById: vi.fn(),
  getUserByUsername: mocks.getUserByUsername,
  updateUser: vi.fn(),
}));

const { loginHandler } = await import('../server/auth.js');

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    cookie: vi.fn(),
  };
}

beforeEach(() => {
  mocks.compareSync.mockReset().mockReturnValue(false);
  mocks.getUserByUsername.mockReset();
});

describe('login credential checks', () => {
  it('performs the password hash check for an unknown username', () => {
    mocks.getUserByUsername.mockReturnValue(undefined);
    const res = response();

    loginHandler({ body: { username: 'missing', password: 'WrongPass1' } }, res);

    expect(mocks.compareSync).toHaveBeenCalledWith(
      'WrongPass1',
      'dummy-password-hash',
    );
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({
      error: 'Invalid username or password',
      failed: true,
    });
  });

  it('does not reveal a disabled admin account before password verification', () => {
    const storedHash = ['stored', 'password', 'hash'].join('-');
    mocks.getUserByUsername.mockReturnValue({
      id: 1,
      username: 'admin',
      password_hash: storedHash,
      must_change_password: 0,
    });
    const res = response();

    loginHandler({ body: { username: 'admin', password: 'WrongPass1' } }, res);

    expect(mocks.compareSync).toHaveBeenCalledWith(
      'WrongPass1',
      storedHash,
    );
    expect(res.statusCode).toBe(401);
  });
});
