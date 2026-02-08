import { configureStore } from '@reduxjs/toolkit';
import authReducer from './authSlice';
import configReducer from './configSlice';
import statusReducer from './statusSlice';
import attendanceReducer from './attendanceSlice';

export const store = configureStore({
  reducer: {
    auth: authReducer,
    config: configReducer,
    status: statusReducer,
    attendance: attendanceReducer,
  },
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
