import { LiveData } from 'interfaces/data';

export type DataItemUIOptions = {
  label?: string;
  unit?: 'V' | 'W' | 'A' | 'Ah' | 'Wh' | 'R' | '%' | '°C';
  decimals?: number;
};
export const liveDataUIConfig: Partial<Record<keyof LiveData, DataItemUIOptions>> = {
  voltage: {
    label: 'Gerilim',
    unit: 'V',
    decimals: 2,
  },
  nominalVoltage: {
    label: 'Nominal Gerilim',
    unit: 'V',
  },
  power: {
    label: 'Güç',
    unit: 'W',
    decimals: 0,
  },
  current: {
    label: 'Anlık',
    unit: 'A',
    decimals: 2,
  },
  cellCount: {
    label: 'Hücre sayısı',
  },
  voltages: {
    unit: 'V',
    decimals: 3,
  },
  averageCellVoltage: {
    label: 'Ort. hücre',
    unit: 'V',
    decimals: 3,
  },
  minVoltage: {
    label: 'Düşük hücre',
    unit: 'V',
    decimals: 3,
  },
  maxVoltage: {
    label: 'Hücre yüksek',
    unit: 'V',
    decimals: 3,
  },
  cellVoltageDelta: {
    label: 'Hücre fark',
    unit: 'V',
    decimals: 3,
  },
  remainingCapacity: {
    label: 'Kalan kapasite',
    unit: 'Ah',
    decimals: 1,
  },
  nominalCapacity: {
    label: 'Nominal kapasite',
    unit: 'Ah',
    decimals: 1,
  },
  // Total energy used (fractional cycleCount * nominalCapacity)
  cycledCapacity: {
    label: 'Döngü kapasitesi',
    unit: 'Ah',
    decimals: 0,
  },
  percentage: {
    label: 'Level',
    unit: '%',
    decimals: 0,
  },
  cycleCount: {
    label: 'Döngü sayısı',
    decimals: 0,
  },
  resistances: {
    unit: 'R',
  },
  avarageCellResistance: {
    label: 'Ort. direnç',
    unit: 'R',
    decimals: 4,
  },
  //  Negative = discharge
  balanceCurrent: {
    label: 'Denge akım',
    unit: 'A',
    decimals: 3,
  },
  // External probes placed near the cells
  temperatureProbes: {
    label: 'T',
    unit: '°C',
    decimals: 1,
  },
  avarageTemperature: {
    label: 'Ort. temp',
    unit: '°C',
  },
  minTemperature: {
    label: 'Düşük temp',
    unit: '°C',
    decimals: 1,
  },
  maxTemperature: {
    label: 'Yüksek temp',
    unit: '°C',
    decimals: 1,
  },
  // Highest Mosfet temp if multiple sensors are present
  mosTemperature: {
    label: 'Mos temp',
    unit: '°C',
    decimals: 1,
  },
  // e.g board sensors
  internalTemperatureProbes: {
    label: 'IT',
    unit: '°C',
    decimals: 1,
  },
};
