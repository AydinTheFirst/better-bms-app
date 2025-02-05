import { Tabs } from '@geist-ui/core';
import { memo } from 'react';
import { Screens } from 'components/organisms/App';
import { useDevice } from 'components/providers/DeviceProvider';
import { BottomNavigationContainer } from './styles';

type BottomNavigationProps = {
  selectedScreen: Screens;
  setSelectedScreen: (newScreen: Screens) => void;
};

const BottomNavigation = ({ selectedScreen, setSelectedScreen }: BottomNavigationProps) => {
  const { status } = useDevice();

  return (
    <BottomNavigationContainer>
      <Tabs value={selectedScreen} onChange={(value) => setSelectedScreen(value as Screens)}>
        <Tabs.Item label='Günlük' value='Logs' />
        <Tabs.Item label='Özet' value='Summary' disabled={status !== 'connected'} />
        <Tabs.Item label='Detaylar' value='Details' disabled={status !== 'connected'} />
        <Tabs.Item label='Ayarlar' value='Settings' disabled={status !== 'connected'} />
      </Tabs>
    </BottomNavigationContainer>
  );
};

export default memo(BottomNavigation);
