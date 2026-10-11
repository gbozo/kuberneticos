import { useEffect, useState } from 'react';
import { Tooltip } from './ui';

export function TaskBarClock() {
  const [now, setNow] = useState<Date>(() => new Date());

  useEffect(() => {
    const intervalId = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(intervalId);
  }, []);

  const isPM = now.getHours() >= 12;
  const hour12 = now.getHours() % 12 === 0 ? 12 : now.getHours() % 12;
  const minutes = now.getMinutes().toString().padStart(2, '0');
  const time = `${hour12}:${minutes} ${isPM ? 'PM' : 'AM'}`;

  return (
    <Tooltip content={now.toLocaleString()}>
      <span className="kos-taskbar-clock">{time}</span>
    </Tooltip>
  );
}
