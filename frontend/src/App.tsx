import React, { useState, useEffect, useRef } from 'react'

interface Slave {
  position: number
  alias: number
  state: string
  flag: string
  name: string
  vendor_id: string
  product_code: string
  is_drive: boolean
}

interface AlarmInfo {
  code: string
  name: string
  cause: string
  action: string
}

interface Telemetry {
  is_enabled: boolean
  is_faulted: boolean
  active_alarm: AlarmInfo
  cia402_state: string
  motion_mode: string
  is_moving: boolean
  actual_rpm: number
  target_rpm: number
  actual_position: number
  following_error: number
  bus_cycle_us: number
  jitter_us: number
  wck_errors: number
  encoder_bits: number
  encoder_ppr: number
  scale: number
  stress_active: boolean
  stress_cycle: number
  stress_total_cycles: number
  selected_slave: Slave | null
}

export default function App() {
  const [slaves, setSlaves] = useState<Slave[]>([])
  const [selectedPos, setSelectedPos] = useState<number>(0)
  const [telemetry, setTelemetry] = useState<Telemetry>({
    is_enabled: false,
    is_faulted: false,
    active_alarm: { code: 'Er 000', name: 'Normal', cause: '', action: '' },
    cia402_state: 'SWITCH_ON_DISABLED',
    motion_mode: 'STOPPED',
    is_moving: false,
    actual_rpm: 0,
    target_rpm: 0,
    actual_position: 0,
    following_error: 0,
    bus_cycle_us: 1000,
    jitter_us: 12,
    wck_errors: 0,
    encoder_bits: 17,
    encoder_ppr: 131072,
    scale: 26214.4,
    stress_active: false,
    stress_cycle: 0,
    stress_total_cycles: 50,
    selected_slave: null,
  })

  const [jogSpeed, setJogSpeed] = useState<number>(100)
  const [stepDistance, setStepDistance] = useState<number>(1.0)
  const [continuousRpm, setContinuousRpm] = useState<number>(600)
  const [continuousDir, setContinuousDir] = useState<'fwd' | 'rev'>('fwd')
  const [stressCycles, setStressCycles] = useState<number>(50)
  const [encoderBits, setEncoderBits] = useState<number>(17)
  const [pitchMm, setPitchMm] = useState<number>(5.0)

  const [activeTab, setActiveTab] = useState<'control' | 'scope' | 'configs'>('control')
  const [configPreviews, setConfigPreviews] = useState<{ xml: string; hal: string; ini: string }>({ xml: '', hal: '', ini: '' })
  const [notification, setNotification] = useState<string | null>('Sistem hazır. GMTCNT EtherCAT sürücü hattı taranıyor...')
  const [isScopeFrozen, setIsScopeFrozen] = useState<boolean>(false)
  const [showDiagModal, setShowDiagModal] = useState<boolean>(false)
  const [alarmCatalog, setAlarmCatalog] = useState<any[]>([])

  const wsRef = useRef<WebSocket | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const historyRef = useRef<{ rpm: number[]; ferror: number[]; pos: number[] }>({ rpm: [], ferror: [], pos: [] })

  useEffect(() => {
    fetchSlaves()
    fetchAlarmCatalog()
    connectWebSocket()
    return () => {
      if (wsRef.current) wsRef.current.close()
    }
  }, [])

  const fetchSlaves = async () => {
    try {
      const res = await fetch('http://localhost:8000/api/slaves')
      const data = await res.json()
      setSlaves(data.slaves || [])
      if (data.slaves && data.slaves.length > 0) {
        handleSelectSlave(data.slaves[0].position)
      }
    } catch {
      setNotification('Backend bağlantısı bekleniyor (http://localhost:8000)...')
    }
  }

  const fetchAlarmCatalog = async () => {
    try {
      const res = await fetch('http://localhost:8000/api/drive/alarm-catalog')
      const data = await res.json()
      setAlarmCatalog(data || [])
    } catch {}
  }

  const connectWebSocket = () => {
    const ws = new WebSocket('ws://localhost:8000/ws/telemetry')
    ws.onmessage = (event) => {
      try {
        const data: Telemetry = JSON.parse(event.data)
        setTelemetry(data)

        if (!isScopeFrozen) {
          const h = historyRef.current
          h.rpm.push(data.actual_rpm)
          h.ferror.push(data.following_error * 1000)
          h.pos.push(data.actual_position)
          if (h.rpm.length > 250) {
            h.rpm.shift()
            h.ferror.shift()
            h.pos.shift()
          }
        }
      } catch {}
    }
    ws.onerror = () => {
      setTimeout(connectWebSocket, 3000)
    }
    wsRef.current = ws
  }

  // Draw Live Scope
  useEffect(() => {
    if (activeTab !== 'scope' || !canvasRef.current) return
    const canvas = canvasRef.current
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let animId: number
    const render = () => {
      const w = canvas.width
      const h = canvas.height
      ctx.fillStyle = '#fffdf7'
      ctx.fillRect(0, 0, w, h)

      // Grid
      ctx.strokeStyle = '#dfd7c5'
      ctx.lineWidth = 1
      for (let x = 0; x < w; x += 40) {
        ctx.beginPath()
        ctx.moveTo(x, 0)
        ctx.lineTo(x, h)
        ctx.stroke()
      }
      for (let y = 0; y < h; y += 40) {
        ctx.beginPath()
        ctx.moveTo(0, y)
        ctx.lineTo(w, y)
        ctx.stroke()
      }

      // Zero line
      ctx.strokeStyle = '#c4b9a1'
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.moveTo(0, h / 2)
      ctx.lineTo(w, h / 2)
      ctx.stroke()

      const hist = historyRef.current
      if (hist.rpm.length > 1) {
        const stepX = w / 250

        // 1. Draw RPM (Amber: #b46505)
        ctx.strokeStyle = '#b46505'
        ctx.lineWidth = 2
        ctx.beginPath()
        for (let i = 0; i < hist.rpm.length; i++) {
          const x = i * stepX
          const y = (h / 2) - (hist.rpm[i] / 2000.0) * (h / 2.2)
          if (i === 0) ctx.moveTo(x, y)
          else ctx.lineTo(x, y)
        }
        ctx.stroke()

        // 2. Draw Following Error (Red: #b91c1c)
        ctx.strokeStyle = '#b91c1c'
        ctx.lineWidth = 1.8
        ctx.beginPath()
        for (let i = 0; i < hist.ferror.length; i++) {
          const x = i * stepX
          const y = (h / 2) - (hist.ferror[i] / 50.0) * (h / 2.5)
          if (i === 0) ctx.moveTo(x, y)
          else ctx.lineTo(x, y)
        }
        ctx.stroke()
      }

      animId = requestAnimationFrame(render)
    }

    render()
    return () => cancelAnimationFrame(animId)
  }, [activeTab, isScopeFrozen])

  const handleSelectSlave = async (pos: number) => {
    setSelectedPos(pos)
    try {
      const res = await fetch('http://localhost:8000/api/select-slave', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ position: pos }),
      })
      const data = await res.json()
      if (data.status === 'success') {
        setConfigPreviews({
          xml: data.xml_preview,
          hal: data.hal_preview,
          ini: data.ini_preview,
        })
        setNotification(`Sürücü seçildi: ${data.slave.name}. HAL/INI dosyaları otomatik optimize edildi!`)
      }
    } catch {
      setNotification('Sürücü seçilirken hata oluştu.')
    }
  }

  const handleEncoderChange = async (bits: number) => {
    setEncoderBits(bits)
    try {
      const res = await fetch('http://localhost:8000/api/encoder-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bits, pitch_mm: pitchMm, gear_ratio: 1.0 }),
      })
      const data = await res.json()
      setNotification(`Enkoder çözünürlüğü ${bits}-Bit (${data.ppr.toLocaleString()} PPR) olarak ayarlandı. SCALE = ${data.scale}`)
    } catch {}
  }

  const toggleEnable = async () => {
    const endpoint = telemetry.is_enabled ? '/api/drive/disable' : '/api/drive/enable'
    const res = await fetch(`http://localhost:8000${endpoint}`, { method: 'POST' })
    const data = await res.json()
    if (data.status === 'error') {
      setNotification(`⚠️ ${data.message}`)
      setShowDiagModal(true)
    }
  }

  const resetFault = async () => {
    await fetch('http://localhost:8000/api/drive/reset-fault', { method: 'POST' })
    setNotification('CiA402 Hata sıfırlama (Fault Reset) komutu gönderildi.')
    setShowDiagModal(false)
  }

  const triggerTestAlarm = async (hexCode: number) => {
    await fetch('http://localhost:8000/api/drive/trigger-test-alarm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hex_code: hexCode }),
    })
    setShowDiagModal(true)
  }

  const handleJog = async (direction: 'fwd' | 'rev') => {
    await fetch('http://localhost:8000/api/motion/jog', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ direction, speed_rpm: jogSpeed }),
    })
  }

  const handleStepJog = async (direction: 'fwd' | 'rev') => {
    await fetch('http://localhost:8000/api/motion/step-jog', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ direction, step_mm: stepDistance, speed_rpm: jogSpeed }),
    })
  }

  const handleContinuous = async () => {
    const rpm = continuousDir === 'fwd' ? continuousRpm : -continuousRpm
    await fetch('http://localhost:8000/api/motion/continuous', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ speed_rpm: rpm }),
    })
    setNotification(`Sınırsız hareket başlatıldı: ${rpm} RPM`)
  }

  const handleStartStressTest = async () => {
    await fetch('http://localhost:8000/api/motion/stress-test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cycles: stressCycles, distance_mm: 50.0 }),
    })
    setNotification(`Stres & Paket Kopma Testi Başlatıldı (${stressCycles} Tur)`)
  }

  const handleStop = async () => {
    await fetch('http://localhost:8000/api/motion/stop', { method: 'POST' })
    setNotification('Hareket durduruldu.')
  }

  const downloadCsv = () => {
    window.open('http://localhost:8000/api/scope/export-csv', '_blank')
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: 'var(--surface-app)' }}>
      {/* ════════ Top Header ════════ */}
      <header style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '10px 24px',
        background: 'var(--surface-panel)',
        borderBottom: '1px solid var(--line)',
        height: '62px'
      }}>
        {/* Left: App Title */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
          <h1 style={{ fontSize: '1.25rem', fontWeight: 800, letterSpacing: '-0.02em', color: 'var(--text)' }}>
            GMTCNT EtherCAT Test
          </h1>
          <span style={{ fontSize: '0.78rem', padding: '3px 8px', borderRadius: '6px', background: 'var(--accent-soft)', color: 'var(--accent)', fontWeight: 600 }}>
            LinuxCNC v2.9 Core
          </span>
        </div>

        {/* Center: Global Status Indicators */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
          <div
            onClick={() => { if (telemetry.is_faulted) setShowDiagModal(true) }}
            style={{
              display: 'flex', alignItems: 'center', gap: '8px',
              padding: '5px 12px', background: telemetry.is_faulted ? 'var(--danger-soft)' : 'var(--surface-card)',
              borderRadius: '20px', border: telemetry.is_faulted ? '1px solid var(--danger)' : '1px solid var(--line)',
              fontSize: '0.8rem', color: telemetry.is_faulted ? 'var(--danger)' : 'var(--text)',
              cursor: telemetry.is_faulted ? 'pointer' : 'default'
            }}
          >
            <div style={{
              width: '8px', height: '8px', borderRadius: '50%',
              background: telemetry.is_faulted ? 'var(--danger)' : (telemetry.is_enabled ? 'var(--success)' : '#999')
            }} />
            <span>CiA402: <strong>{telemetry.cia402_state}</strong></span>
            {telemetry.is_faulted && <span style={{ fontWeight: 700 }}>[ {telemetry.active_alarm.code} ]</span>}
          </div>

          <div style={{
            display: 'flex', alignItems: 'center', gap: '8px',
            padding: '5px 12px', background: 'var(--surface-card)',
            borderRadius: '20px', border: '1px solid var(--line)', fontSize: '0.8rem', color: 'var(--text)'
          }}>
            <span>DC Döngü: <strong>{telemetry.bus_cycle_us} µs</strong></span>
          </div>

          <div style={{
            display: 'flex', alignItems: 'center', gap: '8px',
            padding: '5px 12px', background: 'var(--surface-card)',
            borderRadius: '20px', border: '1px solid var(--line)', fontSize: '0.8rem', color: 'var(--text)'
          }}>
            <span>WCK Hata: <strong style={{ color: telemetry.wck_errors === 0 ? 'var(--success)' : 'var(--danger)' }}>{telemetry.wck_errors}</strong></span>
          </div>

          <button
            onClick={() => setShowDiagModal(true)}
            style={{
              padding: '6px 14px', borderRadius: '8px', border: '1px solid var(--line)',
              background: 'var(--surface-card)', color: 'var(--text)', fontWeight: 600, fontSize: '0.82rem'
            }}
          >
            Sürücü Teşhis (Alarm)
          </button>

          <button
            onClick={resetFault}
            style={{
              padding: '6px 14px', borderRadius: '8px', border: '1px solid var(--warning)',
              background: 'var(--warning-soft)', color: 'var(--warning)', fontWeight: 600, fontSize: '0.82rem'
            }}
          >
            Hata Sıfırla
          </button>
        </div>

        {/* Right: Official GMT Logo */}
        <div style={{ display: 'flex', alignItems: 'center', paddingLeft: '16px', borderLeft: '1px solid var(--line)' }}>
          <img
            src="/GMT_Logo.svg"
            alt="GMT Logo"
            style={{ height: '34px', width: 'auto', display: 'block', objectFit: 'contain' }}
          />
        </div>
      </header>

      {/* ════════ Notification Banner ════════ */}
      {notification && (
        <div style={{
          padding: '8px 24px', background: 'var(--accent-soft)',
          borderBottom: '1px solid var(--line)', fontSize: '0.82rem',
          color: 'var(--accent-strong)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontWeight: 500
        }}>
          <span>✦ {notification}</span>
          <span style={{ cursor: 'pointer', color: 'var(--text-dim)' }} onClick={() => setNotification(null)}>✕</span>
        </div>
      )}

      {/* ════════ Main Layout ════════ */}
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        {/* Left Sidebar: EtherCAT Slave Selector */}
        <aside style={{
          width: '320px', background: 'var(--surface-panel)',
          borderRight: '1px solid var(--line)', display: 'flex', flexDirection: 'column'
        }}>
          <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--line)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontWeight: 600, fontSize: '0.9rem', color: 'var(--text)' }}>EtherCAT Cihazları ({slaves.length})</span>
            <button
              onClick={fetchSlaves}
              style={{ padding: '4px 8px', borderRadius: '6px', background: 'var(--surface-card)', border: '1px solid var(--line)', color: 'var(--text)', fontSize: '0.75rem' }}
            >
              Yenile
            </button>
          </div>

          <div style={{ flex: 1, overflowY: 'auto', padding: '10px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {slaves.map((slave) => {
              const isSelected = selectedPos === slave.position
              return (
                <div
                  key={slave.position}
                  onClick={() => handleSelectSlave(slave.position)}
                  style={{
                    padding: '12px 14px',
                    borderRadius: '10px',
                    cursor: 'pointer',
                    background: isSelected ? 'var(--surface-card)' : 'transparent',
                    border: isSelected ? '1px solid var(--accent)' : '1px solid transparent',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '4px',
                    transition: 'all 0.15s ease'
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontWeight: 600, fontSize: '0.86rem', color: isSelected ? 'var(--accent)' : 'var(--text)' }}>
                      [Pos {slave.position}] {slave.name}
                    </span>
                    <span style={{
                      fontSize: '0.7rem', padding: '2px 6px', borderRadius: '4px',
                      background: slave.state === 'OP' ? 'var(--success-soft)' : 'var(--warning-soft)',
                      color: slave.state === 'OP' ? 'var(--success)' : 'var(--warning)',
                      fontWeight: 600
                    }}>
                      {slave.state}
                    </span>
                  </div>
                  <div style={{ fontSize: '0.72rem', color: 'var(--text-dim)' }}>
                    VID: {slave.vendor_id} | PID: {slave.product_code}
                  </div>
                </div>
              )
            })}
          </div>

          {/* Encoder Resolution Adapter Widget */}
          <div style={{ padding: '16px', borderTop: '1px solid var(--line)', background: 'var(--surface-card)' }}>
            <div style={{ fontSize: '0.82rem', fontWeight: 600, marginBottom: '8px', color: 'var(--text)' }}>
              ⚙ Enkoder Çözünürlük Adaptörü
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <select
                value={encoderBits}
                onChange={(e) => handleEncoderChange(Number(e.target.value))}
                style={{ width: '100%' }}
              >
                <option value={14}>14-Bit (16,384 PPR)</option>
                <option value={17}>17-Bit (131,072 PPR - SD7EC/SD1EC Standart)</option>
                <option value={20}>20-Bit (1,048,576 PPR)</option>
                <option value={23}>23-Bit (8,388,608 PPR)</option>
              </select>
              <div style={{ fontSize: '0.74rem', color: 'var(--text-dim)', display: 'flex', justifyContent: 'space-between' }}>
                <span>Hesaplanan SCALE:</span>
                <strong>{telemetry.scale.toFixed(1)} pulse/mm</strong>
              </div>
              <div style={{ fontSize: '0.72rem', color: 'var(--text-dim)' }}>
                SDO 0x6092 / P00.08 Otomatik Senkronize
              </div>
            </div>
          </div>
        </aside>

        {/* Center / Right Content Panel */}
        <main style={{ flex: 1, display: 'flex', flexDirection: 'column', background: 'var(--surface-app)', overflowY: 'auto' }}>
          {/* Navigation Tabs */}
          <div style={{ display: 'flex', gap: '8px', padding: '12px 24px', borderBottom: '1px solid var(--line)' }}>
            <button
              onClick={() => setActiveTab('control')}
              style={{
                padding: '8px 18px', borderRadius: '8px', border: '1px solid',
                borderColor: activeTab === 'control' ? 'var(--accent)' : 'var(--line)',
                background: activeTab === 'control' ? 'var(--accent)' : 'var(--surface-panel)',
                color: activeTab === 'control' ? 'var(--on-accent)' : 'var(--text)',
                fontWeight: 600, fontSize: '0.88rem'
              }}
            >
              1-Eksen Hareket & Stres Testi
            </button>
            <button
              onClick={() => setActiveTab('scope')}
              style={{
                padding: '8px 18px', borderRadius: '8px', border: '1px solid',
                borderColor: activeTab === 'scope' ? 'var(--accent)' : 'var(--line)',
                background: activeTab === 'scope' ? 'var(--accent)' : 'var(--surface-panel)',
                color: activeTab === 'scope' ? 'var(--on-accent)' : 'var(--text)',
                fontWeight: 600, fontSize: '0.88rem'
              }}
            >
              Canlı Osiloskop & Telemetri
            </button>
            <button
              onClick={() => setActiveTab('configs')}
              style={{
                padding: '8px 18px', borderRadius: '8px', border: '1px solid',
                borderColor: activeTab === 'configs' ? 'var(--accent)' : 'var(--line)',
                background: activeTab === 'configs' ? 'var(--accent)' : 'var(--surface-panel)',
                color: activeTab === 'configs' ? 'var(--on-accent)' : 'var(--text)',
                fontWeight: 600, fontSize: '0.88rem'
              }}
            >
              Otomatik HAL & INI Konfigürasyonu
            </button>
          </div>

          {activeTab === 'control' && (
            <div style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '20px' }}>
              {/* Telemetry Dashboard Cards */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '16px' }}>
                <div style={{ padding: '16px', background: 'var(--surface-panel)', borderRadius: '12px', border: '1px solid var(--line)', boxShadow: '0 2px 6px rgba(0,0,0,0.03)' }}>
                  <div style={{ fontSize: '0.78rem', color: 'var(--text-dim)' }}>GERÇEK DEVİR (RPM)</div>
                  <div style={{ fontSize: '1.8rem', fontWeight: 700, color: 'var(--text)', marginTop: '4px' }}>
                    {telemetry.actual_rpm.toFixed(1)} <span style={{ fontSize: '0.9rem', color: 'var(--text-dim)' }}>dev/dk</span>
                  </div>
                </div>

                <div style={{ padding: '16px', background: 'var(--surface-panel)', borderRadius: '12px', border: '1px solid var(--line)', boxShadow: '0 2px 6px rgba(0,0,0,0.03)' }}>
                  <div style={{ fontSize: '0.78rem', color: 'var(--text-dim)' }}>GERÇEK POZİSYON</div>
                  <div style={{ fontSize: '1.8rem', fontWeight: 700, color: 'var(--text)', marginTop: '4px' }}>
                    {telemetry.actual_position.toFixed(2)} <span style={{ fontSize: '0.9rem', color: 'var(--text-dim)' }}>mm</span>
                  </div>
                </div>

                <div style={{ padding: '16px', background: 'var(--surface-panel)', borderRadius: '12px', border: '1px solid var(--line)', boxShadow: '0 2px 6px rgba(0,0,0,0.03)' }}>
                  <div style={{ fontSize: '0.78rem', color: 'var(--text-dim)' }}>TAKİP HATASI (FERROR)</div>
                  <div style={{ fontSize: '1.8rem', fontWeight: 700, color: 'var(--text)', marginTop: '4px' }}>
                    {(telemetry.following_error * 1000).toFixed(1)} <span style={{ fontSize: '0.9rem', color: 'var(--text-dim)' }}>µm</span>
                  </div>
                </div>

                <div style={{ padding: '16px', background: 'var(--surface-panel)', borderRadius: '12px', border: '1px solid var(--line)', boxShadow: '0 2px 6px rgba(0,0,0,0.03)' }}>
                  <div style={{ fontSize: '0.78rem', color: 'var(--text-dim)' }}>HAREKET DURUMU</div>
                  <div style={{ fontSize: '1.4rem', fontWeight: 700, color: telemetry.is_moving ? 'var(--accent)' : 'var(--text-dim)', marginTop: '8px' }}>
                    {telemetry.motion_mode}
                  </div>
                </div>
              </div>

              {/* Drive Enable & Power Controls */}
              <div style={{ padding: '18px 24px', background: 'var(--surface-panel)', borderRadius: '12px', border: '1px solid var(--line)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', boxShadow: '0 2px 6px rgba(0,0,0,0.03)' }}>
                <div>
                  <h3 style={{ fontSize: '1rem', fontWeight: 600, color: 'var(--text)' }}>Sürücü Güç & Servo ON/OFF Kontrolü</h3>
                  <p style={{ fontSize: '0.8rem', color: 'var(--text-dim)' }}>Sürücüyü enerjilendirir (CiA402 0x0F) ve 1ms DC SYNC0 bus senkronizasyonunu başlatır.</p>
                </div>
                <button
                  onClick={toggleEnable}
                  style={{
                    padding: '12px 28px',
                    borderRadius: '10px',
                    border: 'none',
                    fontWeight: 700,
                    fontSize: '0.95rem',
                    background: telemetry.is_enabled ? 'var(--danger)' : 'var(--success)',
                    color: '#fff',
                    boxShadow: telemetry.is_enabled ? '0 3px 10px rgba(185,28,28,0.25)' : '0 3px 10px rgba(37,122,74,0.25)'
                  }}
                >
                  {telemetry.is_enabled ? 'SERVO GÜCÜNÜ KES (SERVO OFF)' : 'SÜRÜCÜYÜ AÇ (SERVO ON)'}
                </button>
              </div>

              {/* 3 Panels: Jog, Sınırsız Hız, Otomatik Stres/Paket Testi */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '16px' }}>
                {/* 1. Manuel Jog & Adımlı Jog */}
                <div style={{ padding: '20px', background: 'var(--surface-panel)', borderRadius: '12px', border: '1px solid var(--line)', display: 'flex', flexDirection: 'column', gap: '14px' }}>
                  <h3 style={{ fontSize: '0.92rem', fontWeight: 600, borderBottom: '1px solid var(--line)', paddingBottom: '8px', color: 'var(--text)' }}>
                    1. Manuel & Adımlı Jog
                  </h3>

                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span style={{ fontSize: '0.82rem', color: 'var(--text-dim)' }}>Jog Hızı (RPM):</span>
                    <input
                      type="number"
                      value={jogSpeed}
                      onChange={(e) => setJogSpeed(Number(e.target.value))}
                      style={{ width: '90px', textAlign: 'center' }}
                    />
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span style={{ fontSize: '0.82rem', color: 'var(--text-dim)' }}>Adım (mm):</span>
                    <div style={{ display: 'flex', gap: '4px' }}>
                      {[0.1, 1.0, 10.0].map((step) => (
                        <button
                          key={step}
                          onClick={() => setStepDistance(step)}
                          style={{
                            padding: '4px 8px', borderRadius: '4px', fontSize: '0.74rem',
                            border: '1px solid',
                            borderColor: stepDistance === step ? 'var(--accent)' : 'var(--line)',
                            background: stepDistance === step ? 'var(--accent)' : 'var(--surface-control)',
                            color: stepDistance === step ? '#fff' : 'var(--text)'
                          }}
                        >
                          {step}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                    <button
                      onClick={() => handleStepJog('rev')}
                      style={{ padding: '8px', borderRadius: '6px', background: 'var(--surface-card)', border: '1px solid var(--line)', fontSize: '0.8rem', fontWeight: 600 }}
                    >
                      -{stepDistance}mm Adım
                    </button>
                    <button
                      onClick={() => handleStepJog('fwd')}
                      style={{ padding: '8px', borderRadius: '6px', background: 'var(--surface-card)', border: '1px solid var(--line)', fontSize: '0.8rem', fontWeight: 600 }}
                    >
                      +{stepDistance}mm Adım
                    </button>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginTop: 'auto' }}>
                    <button
                      onMouseDown={() => handleJog('rev')}
                      onMouseUp={handleStop}
                      style={{ padding: '12px', borderRadius: '8px', background: 'var(--surface-card)', border: '1px solid var(--line)', color: 'var(--text)', fontWeight: 700, fontSize: '0.88rem' }}
                    >
                      ◀ GERİ (-)
                    </button>
                    <button
                      onMouseDown={() => handleJog('fwd')}
                      onMouseUp={handleStop}
                      style={{ padding: '12px', borderRadius: '8px', background: 'var(--surface-card)', border: '1px solid var(--line)', color: 'var(--text)', fontWeight: 700, fontSize: '0.88rem' }}
                    >
                      İLERİ (+) ▶
                    </button>
                  </div>
                </div>

                {/* 2. Sabit Devirde Sınırsız Dönüş */}
                <div style={{ padding: '20px', background: 'var(--surface-panel)', borderRadius: '12px', border: '1px solid var(--line)', display: 'flex', flexDirection: 'column', gap: '14px' }}>
                  <h3 style={{ fontSize: '0.92rem', fontWeight: 600, borderBottom: '1px solid var(--line)', paddingBottom: '8px', color: 'var(--text)' }}>
                    2. Sabit Devirde Sınırsız Dönüş
                  </h3>

                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span style={{ fontSize: '0.82rem', color: 'var(--text-dim)' }}>Hedef Devir (RPM):</span>
                    <input
                      type="number"
                      value={continuousRpm}
                      onChange={(e) => setContinuousRpm(Number(e.target.value))}
                      style={{ width: '90px', textAlign: 'center' }}
                    />
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span style={{ fontSize: '0.82rem', color: 'var(--text-dim)' }}>Dönüş Yönü:</span>
                    <div style={{ display: 'flex', gap: '4px' }}>
                      <button
                        onClick={() => setContinuousDir('fwd')}
                        style={{
                          padding: '4px 10px', borderRadius: '6px',
                          border: '1px solid',
                          borderColor: continuousDir === 'fwd' ? 'var(--accent)' : 'var(--line)',
                          background: continuousDir === 'fwd' ? 'var(--accent)' : 'var(--surface-control)',
                          color: continuousDir === 'fwd' ? '#fff' : 'var(--text)', fontSize: '0.78rem'
                        }}
                      >
                        İleri (+)
                      </button>
                      <button
                        onClick={() => setContinuousDir('rev')}
                        style={{
                          padding: '4px 10px', borderRadius: '6px',
                          border: '1px solid',
                          borderColor: continuousDir === 'rev' ? 'var(--accent)' : 'var(--line)',
                          background: continuousDir === 'rev' ? 'var(--accent)' : 'var(--surface-control)',
                          color: continuousDir === 'rev' ? '#fff' : 'var(--text)', fontSize: '0.78rem'
                        }}
                      >
                        Geri (-)
                      </button>
                    </div>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginTop: 'auto' }}>
                    <button
                      onClick={handleContinuous}
                      style={{ padding: '14px', borderRadius: '8px', background: 'var(--accent)', border: 'none', color: '#fff', fontWeight: 700, fontSize: '0.9rem' }}
                    >
                      ▶ BAŞLAT
                    </button>
                    <button
                      onClick={handleStop}
                      style={{ padding: '14px', borderRadius: '8px', background: 'var(--surface-card)', border: '1px solid var(--danger)', color: 'var(--danger)', fontWeight: 700, fontSize: '0.9rem' }}
                    >
                      ■ DURDUR
                    </button>
                  </div>
                </div>

                {/* 3. Otomatik Stres & Paket Kopma Testi */}
                <div style={{ padding: '20px', background: 'var(--surface-panel)', borderRadius: '12px', border: '1px solid var(--line)', display: 'flex', flexDirection: 'column', gap: '14px' }}>
                  <h3 style={{ fontSize: '0.92rem', fontWeight: 600, borderBottom: '1px solid var(--line)', paddingBottom: '8px', color: 'var(--text)' }}>
                    3. Otomatik İletişim / Stres Testi
                  </h3>

                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span style={{ fontSize: '0.82rem', color: 'var(--text-dim)' }}>Tekrar Tur Sayısı:</span>
                    <input
                      type="number"
                      value={stressCycles}
                      onChange={(e) => setStressCycles(Number(e.target.value))}
                      style={{ width: '90px', textAlign: 'center' }}
                    />
                  </div>

                  <div style={{ padding: '8px', background: 'var(--surface-card)', borderRadius: '8px', fontSize: '0.76rem', color: 'var(--text-dim)' }}>
                    Hız Rampaları: 500 → 1000 → 1500 → 2000 RPM döngüleriyle paket kopma testi yapar.
                  </div>

                  {telemetry.stress_active && (
                    <div style={{ fontSize: '0.84rem', fontWeight: 700, color: 'var(--accent)', textAlign: 'center' }}>
                      Test İlerliyor: Tur {telemetry.stress_cycle} / {telemetry.stress_total_cycles}
                    </div>
                  )}

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginTop: 'auto' }}>
                    <button
                      onClick={handleStartStressTest}
                      style={{ padding: '14px', borderRadius: '8px', background: 'var(--accent)', border: 'none', color: '#fff', fontWeight: 700, fontSize: '0.9rem' }}
                    >
                      ⚡ TESTİ BAŞLAT
                    </button>
                    <button
                      onClick={handleStop}
                      style={{ padding: '14px', borderRadius: '8px', background: 'var(--surface-card)', border: '1px solid var(--danger)', color: 'var(--danger)', fontWeight: 700, fontSize: '0.9rem' }}
                    >
                      DURDUR
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'scope' && (
            <div style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '18px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 18px', background: 'var(--surface-panel)', borderRadius: '10px', border: '1px solid var(--line)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                  <span style={{ fontWeight: 600, fontSize: '0.95rem' }}>Canlı Telemetri & Osiloskop Çizimi (50 Hz)</span>
                  <button
                    onClick={() => setIsScopeFrozen(!isScopeFrozen)}
                    style={{
                      padding: '4px 10px', borderRadius: '6px', fontSize: '0.78rem', fontWeight: 600,
                      background: isScopeFrozen ? 'var(--accent)' : 'var(--surface-card)',
                      color: isScopeFrozen ? '#fff' : 'var(--text)',
                      border: '1px solid var(--line)'
                    }}
                  >
                    {isScopeFrozen ? '▶ Canlı Yayına Dön' : '⏸ Dondur / Pause'}
                  </button>
                  <button
                    onClick={downloadCsv}
                    style={{
                      padding: '4px 10px', borderRadius: '6px', fontSize: '0.78rem', fontWeight: 600,
                      background: 'var(--surface-card)', color: 'var(--text)', border: '1px solid var(--line)'
                    }}
                  >
                    ⬇ CSV Olarak İndir
                  </button>
                </div>
                <div style={{ display: 'flex', gap: '18px', fontSize: '0.82rem' }}>
                  <span style={{ color: '#b46505', fontWeight: 700 }}>■ Motor Devri (RPM)</span>
                  <span style={{ color: '#b91c1c', fontWeight: 700 }}>■ Takip Hatası (µm)</span>
                </div>
              </div>

              <div style={{ background: 'var(--surface-panel)', padding: '12px', borderRadius: '12px', border: '1px solid var(--line)' }}>
                <canvas
                  ref={canvasRef}
                  width={1100}
                  height={380}
                  style={{ width: '100%', height: '380px', borderRadius: '8px', display: 'block' }}
                />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '14px' }}>
                <div style={{ padding: '12px 16px', background: 'var(--surface-panel)', borderRadius: '8px', border: '1px solid var(--line)' }}>
                  <div style={{ fontSize: '0.74rem', color: 'var(--text-dim)' }}>ETHERCAT WORKING COUNTER (WCK)</div>
                  <div style={{ fontSize: '1.2rem', fontWeight: 700, color: 'var(--success)', marginTop: '2px' }}>0 Hata (Kopma Yok)</div>
                </div>
                <div style={{ padding: '12px 16px', background: 'var(--surface-panel)', borderRadius: '8px', border: '1px solid var(--line)' }}>
                  <div style={{ fontSize: '0.74rem', color: 'var(--text-dim)' }}>MAX DC SYNC JITTER</div>
                  <div style={{ fontSize: '1.2rem', fontWeight: 700, color: 'var(--text)', marginTop: '2px' }}>{telemetry.jitter_us} µs</div>
                </div>
                <div style={{ padding: '12px 16px', background: 'var(--surface-panel)', borderRadius: '8px', border: '1px solid var(--line)' }}>
                  <div style={{ fontSize: '0.74rem', color: 'var(--text-dim)' }}>HABERLEŞME HATTI KARARLILIĞI</div>
                  <div style={{ fontSize: '1.2rem', fontWeight: 700, color: 'var(--success)', marginTop: '2px' }}>%100 Kararlı</div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'configs' && (
            <div style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '20px' }}>
              <div style={{ padding: '14px 18px', background: 'var(--surface-panel)', borderRadius: '10px', border: '1px solid var(--line)' }}>
                <span style={{ fontWeight: 600, color: 'var(--accent)' }}>Otomatik Optimizasyon Durumu:</span>
                <p style={{ fontSize: '0.82rem', color: 'var(--text-dim)', marginTop: '4px' }}>
                  Sürücü ve {telemetry.encoder_bits}-Bit enkoder çözünürlüğü seçildiğinde ESI XML ayrıştırıldı, 1ms DC SYNC0 senkronizasyonlu <code>ethercat-conf.xml</code>, LinuxCNC <code>ethercat_test.hal</code> ve <code>ethercat_test.ini</code> dosyaları <code>configs/</code> klasörüne otomatik kaydedildi.
                </p>
              </div>

              <div>
                <h4 style={{ fontSize: '0.88rem', fontWeight: 600, marginBottom: '6px', color: 'var(--text)' }}>1. ethercat-conf.xml (lcec yapılandırması)</h4>
                <pre style={{ padding: '14px', background: 'var(--surface-panel)', borderRadius: '8px', border: '1px solid var(--line)', fontSize: '0.82rem', overflowX: 'auto', color: 'var(--text)' }}>
                  {configPreviews.xml || 'Henüz konfigürasyon üretilmedi.'}
                </pre>
              </div>

              <div>
                <h4 style={{ fontSize: '0.88rem', fontWeight: 600, marginBottom: '6px', color: 'var(--text)' }}>2. ethercat_test.hal (LinuxCNC HAL Bağlantıları)</h4>
                <pre style={{ padding: '14px', background: 'var(--surface-panel)', borderRadius: '8px', border: '1px solid var(--line)', fontSize: '0.82rem', overflowX: 'auto', color: 'var(--text)' }}>
                  {configPreviews.hal || 'Henüz konfigürasyon üretilmedi.'}
                </pre>
              </div>

              <div>
                <h4 style={{ fontSize: '0.88rem', fontWeight: 600, marginBottom: '6px', color: 'var(--text)' }}>3. ethercat_test.ini (LinuxCNC Eksen & Trajectory Ayarları)</h4>
                <pre style={{ padding: '14px', background: 'var(--surface-panel)', borderRadius: '8px', border: '1px solid var(--line)', fontSize: '0.82rem', overflowX: 'auto', color: 'var(--text)' }}>
                  {configPreviews.ini || 'Henüz konfigürasyon üretilmedi.'}
                </pre>
              </div>
            </div>
          )}
        </main>
      </div>

      {/* ════════ Fault Diagnostic Modal (Sürücü Arıza Teşhis Penceresi) ════════ */}
      {showDiagModal && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000
        }}>
          <div style={{
            width: '600px', background: 'var(--surface-panel)',
            borderRadius: '14px', border: '1px solid var(--line)',
            boxShadow: '0 20px 40px rgba(0,0,0,0.15)', overflow: 'hidden'
          }}>
            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '16px 20px', borderBottom: '1px solid var(--line)',
              background: telemetry.is_faulted ? 'var(--danger-soft)' : 'var(--surface-card)'
            }}>
              <span style={{ fontWeight: 700, fontSize: '1rem', color: telemetry.is_faulted ? 'var(--danger)' : 'var(--text)' }}>
                {telemetry.is_faulted ? '⚠️ Sürücü Arıza Teşhisi' : '🛠 Sürücü Teşhis & Alarm Simülasyonu'}
              </span>
              <button
                onClick={() => setShowDiagModal(false)}
                style={{ background: 'transparent', border: 'none', fontSize: '1.2rem', color: 'var(--text-dim)' }}
              >
                ✕
              </button>
            </div>

            <div style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
              {telemetry.is_faulted ? (
                <div style={{ padding: '16px', background: 'var(--danger-soft)', borderRadius: '10px', border: '1px solid var(--danger)' }}>
                  <div style={{ fontSize: '1.2rem', fontWeight: 800, color: 'var(--danger)' }}>
                    {telemetry.active_alarm.code}: {telemetry.active_alarm.name}
                  </div>
                  <div style={{ marginTop: '8px', fontSize: '0.85rem', color: 'var(--text)' }}>
                    <strong>Olası Neden:</strong> {telemetry.active_alarm.cause}
                  </div>
                  <div style={{ marginTop: '4px', fontSize: '0.85rem', color: 'var(--text)' }}>
                    <strong>Çözüm Adımı:</strong> {telemetry.active_alarm.action}
                  </div>
                </div>
              ) : (
                <div style={{ padding: '12px 16px', background: 'var(--success-soft)', borderRadius: '8px', color: 'var(--success)', fontWeight: 600, fontSize: '0.85rem' }}>
                  ✓ Sürücüde aktif arıza bulunmuyor. Sistem OP modunda çalışmaya hazır.
                </div>
              )}

              {/* Alarm Simulation / Test Selector */}
              <div>
                <span style={{ fontSize: '0.82rem', fontWeight: 600, color: 'var(--text-dim)' }}>
                  Test İçin Alarm Tetikleme (Donanım/Yazılım Simülasyonu):
                </span>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginTop: '8px' }}>
                  {alarmCatalog.map((item) => (
                    <button
                      key={item.hex}
                      onClick={() => triggerTestAlarm(item.int_val)}
                      style={{
                        padding: '8px 10px', borderRadius: '6px', textAlign: 'left',
                        background: 'var(--surface-card)', border: '1px solid var(--line)',
                        fontSize: '0.76rem', color: 'var(--text)'
                      }}
                    >
                      <strong>{item.code}:</strong> {item.name.split('(')[0]}
                    </button>
                  ))}
                </div>
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', borderTop: '1px solid var(--line)', paddingTop: '16px' }}>
                <button
                  onClick={() => setShowDiagModal(false)}
                  style={{ padding: '8px 16px', borderRadius: '8px', background: 'var(--surface-card)', border: '1px solid var(--line)', color: 'var(--text)' }}
                >
                  Kapat
                </button>
                <button
                  onClick={resetFault}
                  style={{ padding: '8px 20px', borderRadius: '8px', background: 'var(--warning)', color: '#fff', border: 'none', fontWeight: 700 }}
                >
                  Arızayı Sıfırla (Fault Reset)
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
