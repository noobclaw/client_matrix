import React, { useState, useEffect, useCallback, useRef } from 'react';
import { noobClawApi } from '../../services/noobclawApi';
import { i18nService } from '../../services/i18n';

/* ────────────────────────────────────────────────────────────────
   LuckyBag — Lucky Bag Component
   - After AI conversation consumes credits, the backend generates a lucky bag stored in memory
   - Frontend displays the lucky bag -> user clicks -> calls /lucky-bag/claim to collect
   - Can only collect lucky bags generated from AI credit consumption, cannot exploit the API
   - If not clicked within 30 seconds -> floats away and disappears
   ──────────────────────────────────────────────────────────────── */

const BAG_LIFETIME = 30_000;
const PARTICLE_COUNT = 18;
const REWARD_DISPLAY_DURATION = 3_500;

type Phase = 'idle' | 'entering' | 'visible' | 'opening' | 'reward' | 'miss' | 'exiting';

interface Particle {
  id: number;
  angle: number;
  distance: number;
  size: number;
  color: string;
  delay: number;
}

const PARTICLE_COLORS = ['#00FF88', '#00D4FF', '#FFD700', '#FF6B6B', '#7B5CF6', '#F72585', '#FFC107'];
const randomBetween = (min: number, max: number) => Math.random() * (max - min) + min;

const generateParticles = (): Particle[] =>
  Array.from({ length: PARTICLE_COUNT }, (_, i) => ({
    id: i,
    angle: (360 / PARTICLE_COUNT) * i + randomBetween(-15, 15),
    distance: randomBetween(40, 100),
    size: randomBetween(3, 7),
    color: PARTICLE_COLORS[Math.floor(Math.random() * PARTICLE_COLORS.length)],
    delay: randomBetween(0, 0.15),
  }));

const LuckyBag: React.FC = () => {
  const [phase, setPhase] = useState<Phase>('idle');
  const [reward, setReward] = useState(0);
  const [particles, setParticles] = useState<Particle[]>([]);
  const lifetimeTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const openingRef = useRef(false);
  const pendingRewardRef = useRef(0);

  const dismiss = useCallback(() => {
    setPhase('exiting');
    setTimeout(() => {
      setPhase('idle');
      setParticles([]);
    }, 800);
  }, []);

  // Listen for lucky-bag events dispatched from the backend via SSE (triggered only on hit)
  useEffect(() => {
    const handler = (e: Event) => {
      if (phase !== 'idle') return;
      const detail = (e as CustomEvent).detail;
      if (detail?.reward) {
        pendingRewardRef.current = detail.reward;
      }

      setPhase('entering');
      setTimeout(() => setPhase('visible'), 50);

      lifetimeTimerRef.current = setTimeout(() => {
        setPhase('exiting');
        setTimeout(() => setPhase('idle'), 800);
      }, BAG_LIFETIME);
    };

    window.addEventListener('noobclaw:lucky-bag', handler);
    return () => {
      window.removeEventListener('noobclaw:lucky-bag', handler);
    };
  }, [phase]);

  // Cleanup timer on unmount only
  useEffect(() => {
    return () => {
      if (lifetimeTimerRef.current) clearTimeout(lifetimeTimerRef.current);
    };
  }, []);

  // User clicks the lucky bag -> prize confirmed, display reward and call claim to confirm
  const handleOpen = useCallback(async () => {
    if (phase !== 'visible' || openingRef.current) return;
    openingRef.current = true;
    if (lifetimeTimerRef.current) clearTimeout(lifetimeTimerRef.current);

    setParticles(generateParticles());
    setPhase('opening');

    // Display the known reward amount
    const knownReward = pendingRewardRef.current;
    setReward(knownReward);
    setPhase('reward');
    setTimeout(dismiss, REWARD_DISPLAY_DURATION);

    // Call claim API in the background to confirm collection
    noobClawApi.claimLuckyBag().catch(() => {});
    pendingRewardRef.current = 0;
    openingRef.current = false;
  }, [phase, dismiss]);

  if (phase === 'idle') return null;

  return (
    <div className="nc-lucky-bag-anchor">
      <div
        className={`nc-lucky-bag ${phase}`}
        onClick={handleOpen}
        title={i18nService.t('luckyBagClickHint')}
      >
        {/* Glowing pulse ring */}
        {(phase === 'visible' || phase === 'entering') && (
          <div className="nc-lb-pulse-ring" />
        )}

        {/* Lucky bag icon */}
        {phase !== 'reward' && phase !== 'miss' && (
          <div className={`nc-lb-icon ${phase === 'opening' ? 'nc-lb-explode' : ''}`}>
            <svg viewBox="0 0 64 64" width="36" height="36" fill="none">
              <path
                d="M14 28 C14 22 20 18 32 18 C44 18 50 22 50 28 L48 56 C48 58 46 60 44 60 L20 60 C18 60 16 58 16 56 Z"
                fill="url(#bagGrad)"
                stroke="#FFD700"
                strokeWidth="1.5"
              />
              <ellipse cx="32" cy="20" rx="14" ry="4" fill="#C0392B" stroke="#FFD700" strokeWidth="1" />
              <path
                d="M28 14 Q32 8 36 14"
                stroke="#FFD700"
                strokeWidth="2"
                strokeLinecap="round"
                fill="none"
              />
              <circle cx="32" cy="13" r="2.5" fill="#FFD700" />
              <text
                x="32" y="44"
                textAnchor="middle"
                fontSize="16"
                fontWeight="bold"
                fill="#FFD700"
                fontFamily="sans-serif"
              >
                $
              </text>
              <defs>
                <linearGradient id="bagGrad" x1="14" y1="18" x2="50" y2="60" gradientUnits="userSpaceOnUse">
                  <stop offset="0%" stopColor="#E74C3C" />
                  <stop offset="100%" stopColor="#C0392B" />
                </linearGradient>
              </defs>
            </svg>
          </div>
        )}

        {/* Explosion particles */}
        {(phase === 'opening' || phase === 'reward') && (
          <div className="nc-lb-particles">
            {particles.map((p) => (
              <div
                key={p.id}
                className="nc-lb-particle"
                style={{
                  '--p-angle': `${p.angle}deg`,
                  '--p-dist': `${p.distance}px`,
                  '--p-size': `${p.size}px`,
                  '--p-color': p.color,
                  '--p-delay': `${p.delay}s`,
                } as React.CSSProperties}
              />
            ))}
          </div>
        )}

        {/* Prize won */}
        {phase === 'reward' && (
          <div className="nc-lb-reward">
            <img src="logo.png" alt="NoobCoin" className="nc-lb-reward-coin-img" />
            <div className="nc-lb-reward-amount">+{reward}</div>
            <div className="nc-lb-reward-label">$NoobCoin</div>
          </div>
        )}

        {/* No prize */}
        {phase === 'miss' && (
          <div className="nc-lb-reward">
            <div className="nc-lb-reward-coin" style={{ opacity: 0.5 }}>🧧</div>
            <div className="nc-lb-reward-amount" style={{ color: '#999', fontSize: 13, textShadow: 'none' }}>{i18nService.t('luckyBagMiss')}</div>
          </div>
        )}

        {/* Hint text */}
        {phase === 'visible' && (
          <div className="nc-lb-hint">{i18nService.t('luckyBagOpen')}</div>
        )}
      </div>
    </div>
  );
};

export default React.memo(LuckyBag);
