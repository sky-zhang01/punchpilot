import { configureStore } from '@reduxjs/toolkit';
import authReducer from './authSlice';
import configReducer from './configSlice';
import statusReducer from './statusSlice';
import attendanceReducer from './attendanceSlice';
import { subscribeIdentity } from '../http';

export const store = configureStore({
  reducer: {
    auth: authReducer,
    config: configReducer,
    status: statusReducer,
    attendance: attendanceReducer,
    identity: (state: number = 0, action: { type: string }) => action.type === 'account/identityChanged' ? state + 1 : state,
  },
});
subscribeIdentity(() => store.dispatch({ type: 'account/identityChanged' }));

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
