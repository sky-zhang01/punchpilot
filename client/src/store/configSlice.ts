import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import api from '../api';

import type { ScheduleConfig, ScheduleUpdate } from '../contracts';

interface ConfigState {
  schedules: ScheduleConfig[];
  autoEnabled: boolean;
  debugMode: boolean;
  freeeConfigured: boolean;
  webCredentialsConfigured: boolean;
  freeeUsername: string;
  webIdentityVerified: boolean;
  connectionMode: string;
  oauthConfigured: boolean;
  oauthCompanyId: string;
  holidaySkipCountries: string;
  loading: boolean;
  requestId: string | null;
}

const initialState: ConfigState = {
  schedules: [],
  autoEnabled: true,
  debugMode: true,
  freeeConfigured: false,
  webCredentialsConfigured: false,
  freeeUsername: '',
  webIdentityVerified: false,
  connectionMode: 'api',
  oauthConfigured: false,
  oauthCompanyId: '',
  holidaySkipCountries: 'jp',
  loading: false,
  requestId: null,
};

export const fetchConfig = createAsyncThunk('config/fetchConfig', async () => {
  const res = await api.getConfig();
  return res.data;
});

export const updateSchedule = createAsyncThunk(
  'config/updateSchedule',
  async ({ actionType, data }: { actionType: string; data: ScheduleUpdate }, { dispatch }) => {
    const res = await api.updateConfig(actionType, data);
    await dispatch(fetchConfig()).unwrap();
    return res.data;
  }
);

export const toggleMaster = createAsyncThunk('config/toggleMaster', async () => {
  const res = await api.toggleMaster();
  return res.data;
});

export const toggleDebug = createAsyncThunk('config/toggleDebug', async () => {
  const res = await api.toggleDebug();
  return res.data;
});

export const saveAccount = createAsyncThunk(
  'config/saveAccount',
  async ({ username, password, companyName }: { username: string; password: string; companyName: string }) => {
    const res = await api.saveAccount(username, password, companyName);
    return res.data;
  }
);

export const clearAccount = createAsyncThunk('config/clearAccount', async () => {
  const res = await api.clearAccount();
  return res.data;
});

export const setConnectionMode = createAsyncThunk(
  'config/setConnectionMode',
  async (mode: string, { dispatch }) => {
    const res = await api.setConnectionMode(mode);
    dispatch(fetchConfig());
    return res.data;
  }
);

const configSlice = createSlice({
  name: 'config',
  initialState,
  reducers: {},
  extraReducers: (builder) => {
    builder.addCase('account/identityChanged', (state) => { state.requestId = null; state.loading = false; });
    // Fetch config
    builder.addCase(fetchConfig.pending, (state, action) => {
      state.requestId = action.meta.requestId;
      state.loading = true;
    });
    builder.addCase(fetchConfig.fulfilled, (state, action) => {
      if (state.requestId !== action.meta.requestId) return;
      state.requestId = null;
      state.schedules = action.payload.schedules;
      state.autoEnabled = action.payload.auto_checkin_enabled;
      state.debugMode = action.payload.debug_mode;
      state.freeeConfigured = action.payload.freee_configured;
      state.webCredentialsConfigured = action.payload.web_credentials_configured || false;
      state.freeeUsername = action.payload.freee_username;
      state.webIdentityVerified = action.payload.web_identity_verified || false;
      state.connectionMode = action.payload.connection_mode || 'api';
      state.oauthConfigured = action.payload.oauth_configured || false;
      state.oauthCompanyId = action.payload.oauth_company_id || '';
      state.holidaySkipCountries = action.payload.holiday_skip_countries || 'jp';
      state.loading = false;
    });
    builder.addCase(fetchConfig.rejected, (state, action) => {
      if (state.requestId !== action.meta.requestId) return;
      state.requestId = null;
      state.loading = false;
    });

    // Toggle master
    builder.addCase(toggleMaster.fulfilled, (state, action) => {
      state.autoEnabled = action.payload.auto_checkin_enabled;
    });

    // Toggle debug
    builder.addCase(toggleDebug.fulfilled, (state, action) => {
      state.debugMode = action.payload.debug_mode;
    });

    // Save account
    builder.addCase(saveAccount.fulfilled, (state, action) => {
      state.freeeConfigured = action.payload.freee_configured;
      state.webCredentialsConfigured = action.payload.web_credentials_configured ?? true;
      state.freeeUsername = action.payload.freee_username;
      state.webIdentityVerified = action.payload.web_identity_verified || false;
    });

    // Clear account
    builder.addCase(clearAccount.fulfilled, (state, action) => {
      state.freeeConfigured = action.payload.freee_configured;
      state.webCredentialsConfigured = action.payload.web_credentials_configured || false;
      state.freeeUsername = '';
      state.webIdentityVerified = false;
    });

    // Set connection mode
    builder.addCase(setConnectionMode.fulfilled, (state, action) => {
      state.connectionMode = action.payload.connection_mode;
    });
  },
});

export default configSlice.reducer;
