import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import api from '../api';

interface StatusState {
  data: any | null;
  loading: boolean;
}

const initialState: StatusState = {
  data: null,
  loading: false,
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
    builder.addCase(fetchStatus.pending, (state) => {
      state.loading = true;
    });
    builder.addCase(fetchStatus.fulfilled, (state, action) => {
      state.data = action.payload;
      state.loading = false;
    });
    builder.addCase(fetchStatus.rejected, (state) => {
      state.loading = false;
    });
  },
});

export default statusSlice.reducer;
