import React from 'react';
import { Space } from 'antd';
import OAuthConfigCard from '../components/settings/OAuthConfigCard';
import BrowserAccountCard from '../components/settings/BrowserAccountCard';
import MockModeCard from '../components/settings/MockModeCard';
import ScheduleConfigCard from '../components/settings/ScheduleConfigCard';

const SettingsPage: React.FC = () => {
  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <OAuthConfigCard />
      <BrowserAccountCard />
      <MockModeCard />
      <ScheduleConfigCard />
    </Space>
  );
};

export default SettingsPage;
