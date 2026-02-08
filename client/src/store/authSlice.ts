import { createSlice, createAsyncThunk, PayloadAction } from '@reduxjs/toolkit';
import api from '../api';

interface AuthState {
  authenticated: boolean;
  checked: boolean;
  username: string;
  mustChangePassword: boolean;
  loading: boolean;
}

const initialState: AuthState = {
  authenticated: false,
  checked: false,
  username: '',
  mustChangePassword: false,
  loading: false,
};

export const checkAuthStatus = createAsyncThunk('auth/checkStatus', async () => {
  const res = await api.authStatus();
  return res.data;
});

export const loginUser = createAsyncThunk(
  'auth/login',
  async ({ username, password }: { username: string; password: string }) => {
    const res = await api.login(username, password);
    return res.data;
  }
);

export const logoutUser = createAsyncThunk('auth/logout', async () => {
  await api.logout();
});

export const changePassword = createAsyncThunk(
  'auth/changePassword',
  async (data: { current_password?: string; new_username?: string; new_password: string }) => {
    const res = await api.changePassword(data);
    return res.data;
  }
);

const authSlice = createSlice({
  name: 'auth',
  initialState,
  reducers: {},
  extraReducers: (builder) => {
    // Check status
    builder.addCase(checkAuthStatus.fulfilled, (state, action) => {
      state.authenticated = action.payload.authenticated;
      state.username = action.payload.username || '';
      state.mustChangePassword = !!action.payload.must_change_password;
      state.checked = true;
    });
    builder.addCase(checkAuthStatus.rejected, (state) => {
      state.authenticated = false;
      state.username = '';
      state.mustChangePassword = false;
      state.checked = true;
    });

    // Login
    builder.addCase(loginUser.pending, (state) => {
      state.loading = true;
    });
    builder.addCase(loginUser.fulfilled, (state, action) => {
      state.authenticated = true;
      state.username = action.payload.username || '';
      state.mustChangePassword = !!action.payload.must_change_password;
      state.loading = false;
    });
    builder.addCase(loginUser.rejected, (state) => {
      state.loading = false;
    });

    // Logout
    builder.addCase(logoutUser.fulfilled, (state) => {
      state.authenticated = false;
      state.username = '';
      state.mustChangePassword = false;
    });

    // Change password
    builder.addCase(changePassword.fulfilled, (state, action) => {
      state.username = action.payload.username || '';
      state.mustChangePassword = false;
    });
  },
});

export default authSlice.reducer;
