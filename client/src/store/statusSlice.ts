import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import api from '../api';
import type { StatusDTO } from '../contracts';

interface StatusState {
  data: StatusDTO | null;
  loading: boolean;
  requestId: string | null;
}

const initialState: StatusState = {
  data: null,
  loading: false,
  requestId: null,
};

export const fetchStatus = createAsyncThunk('status/fetchStatus', async () => {
  const res = await api.getStatus();
  return res.data;
});

const statusSlice = createSlice({
  name: 'status',
  initialState,
  reducers: {},
  extraReducers: (builder) => {
    builder.addCase('account/identityChanged', () => initialState);
    builder.addCase(fetchStatus.pending, (state, action) => {
      state.loading = true;
      state.requestId = action.meta.requestId;
    });
    builder.addCase(fetchStatus.fulfilled, (state, action) => {
      if (state.requestId !== action.meta.requestId) return;
      state.data = action.payload;
      state.loading = false;
      state.requestId = null;
    });
    builder.addCase(fetchStatus.rejected, (state, action) => {
      if (state.requestId !== action.meta.requestId) return;
      state.loading = false;
      state.requestId = null;
    });
  },
});

export default statusSlice.reducer;
