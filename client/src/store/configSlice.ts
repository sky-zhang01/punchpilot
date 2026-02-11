import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import api from '../api';

interface Schedule {
  action_type: string;
  mode: string;
  fixed_time: string;
  window_start: string;
  window_end: string;
  resolved_time: string;
  enabled: boolean;
}

interface ConfigState {
  schedules: Schedule[];
  autoEnabled: boolean;
  debugMode: boolean;
  freeeConfigured: boolean;
  freeeUsername: string;
  connectionMode: string;
  oauthConfigured: boolean;
  holidaySkipCountries: string;
  loading: boolean;
}

const initialState: ConfigState = {
  schedules: [],
  autoEnabled: true,
  debugMode: true,
  freeeConfigured: false,
  freeeUsername: '',
  connectionMode: 'api',
  oauthConfigured: false,
  holidaySkipCountries: 'jp',
  loading: false,
};

export const fetchConfig = createAsyncThunk('config/fetchConfig', async () => {
  const res = await api.getConfig();
  return res.data;
});

export const updateSchedule = createAsyncThunk(
  'config/updateSchedule',
  async ({ actionType, data }: { actionType: string; data: Record<string, any> }, { dispatch }) => {
    const res = await api.updateConfig(actionType, data);
    await dispatch(fetchConfig());
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
  async ({ username, password }: { username: string; password: string }) => {
    const res = await api.saveAccount(username, password);
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
    // Fetch config
    builder.addCase(fetchConfig.pending, (state) => {
      state.loading = true;
    });
    builder.addCase(fetchConfig.fulfilled, (state, action) => {
      state.schedules = action.payload.schedules;
      state.autoEnabled = action.payload.auto_checkin_enabled;
      state.debugMode = action.payload.debug_mode;
      state.freeeConfigured = action.payload.freee_configured;
      state.freeeUsername = action.payload.freee_username;
      state.connectionMode = action.payload.connection_mode || 'browser';
      state.oauthConfigured = action.payload.oauth_configured || false;
      state.holidaySkipCountries = action.payload.holiday_skip_countries || 'jp';
      state.loading = false;
    });
    builder.addCase(fetchConfig.rejected, (state) => {
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
      state.freeeUsername = action.payload.freee_username;
    });

    // Clear account
    builder.addCase(clearAccount.fulfilled, (state, action) => {
      state.freeeConfigured = action.payload.freee_configured;
      state.freeeUsername = '';
    });

    // Set connection mode
    builder.addCase(setConnectionMode.fulfilled, (state, action) => {
      state.connectionMode = action.payload.connection_mode;
    });
  },
});

export default configSlice.reducer;
