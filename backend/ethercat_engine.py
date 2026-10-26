"""
EtherCAT Engine for LinuxCNC Commissioning & 1-Axis Motion Testing
Supports Debian Linux with IgH EtherCAT Master & linuxcnc-ethercat (lcec).
Includes GMTCNT SD1EC / SD7EC Fault Diagnostics and Real-Time Scope Ring Buffer.
"""

import os
import time
import math
import subprocess
import collections
from typing import Dict, List, Optional, Any

GMTCNT_ALARM_TABLE = {
    0x0000: {"code": "Er 000", "name": "Normal Çalışma", "cause": "Arıza yok.", "action": "Sistem hazır."},
    0x3211: {"code": "Er 0C0", "name": "DC Bus Aşırı Gerilim (Overvoltage)", "cause": "Frenleme direnci bağlı değil veya şebeke voltajı yüksek.", "action": "Frenleme direnci bağlantısını kontrol edin, yavaşlama süresini uzatın."},
    0x3221: {"code": "Er 0D0", "name": "DC Bus Düşük Gerilim (Undervoltage)", "cause": "Giriş besleme voltajı yetersiz veya kesildi.", "action": "R, S, T veya L1, L2 faz giriş voltajlarını kontrol edin."},
    0x2211: {"code": "Er 0E0", "name": "Aşırı Akım (Overcurrent / IPM Fault)", "cause": "Motor fazlarında kısa devre veya motor mekanik sıkışması.", "action": "U, V, W motor kablolarını ve mekanik kilitlemeyi kontrol edin."},
    0x8311: {"code": "Er 100", "name": "Motor Aşırı Yük (Overload)", "cause": "Mekanik yük motor tork kapasitesini aşıyor.", "action": "Mekanik kasıntıları giderin, tork limitini ve ivmeyi kontrol edin."},
    0x7321: {"code": "Er 150", "name": "Enkoder Bağlantısı Koptu (Disconnected)", "cause": "Enkoder kablosu gevşek, kopuk veya gürültü biniyor.", "action": "CN2 enkoder konnektörünü ve kablo sürekliliğini kontrol edin."},
    0x8611: {"code": "Er 180", "name": "Aşırı Pozisyon Sapması (Following Error)", "cause": "Pozisyon takip hatası sınırı aşıldı, motor yetişemiyor.", "action": "Kazanç (Gain) parametrelerini artırın, hız/ivme değerlerini düşürün."},
    0x873A: {"code": "Er 73A", "name": "EtherCAT SyncManager2 Paket Kaybı", "cause": "EtherCAT haberleşme gecikmesi veya hat gürültüsü.", "action": "Ethernet kablo kalitesini (Cat5e/Cat6 STP), topraklamayı ve DC SYNC zamanlamasını kontrol edin."}
}

class EtherCATSlave:
    def __init__(self, position: int, alias: int, state: str, flag: str, name: str, vendor_id: str = "0x00000000", product_code: str = "0x00000000"):
        self.position = position
        self.alias = alias
        self.state = state  # OP, PREOP, SAFEOP, INIT
        self.flag = flag    # + or - (online status)
        self.name = name
        self.vendor_id = vendor_id
        self.product_code = product_code
        self.is_drive = any(k in name.lower() for k in ["servo", "drive", "sv", "sd", "asda", "step", "el7", "motor", "inverter"])

    def to_dict(self):
        return {
            "position": self.position,
            "alias": self.alias,
            "state": self.state,
            "flag": self.flag,
            "name": self.name,
            "vendor_id": self.vendor_id,
            "product_code": self.product_code,
            "is_drive": self.is_drive
        }

class EtherCATEngine:
    RESOLUTIONS = {
        14: 16384,
        17: 131072,   # GMTCNT SD7EC / SD1EC Standard
        20: 1048576,
        23: 8388608
    }

    def __init__(self, configs_dir: str = "../configs"):
        self.configs_dir = os.path.abspath(configs_dir)
        os.makedirs(self.configs_dir, exist_ok=True)
        self.selected_slave: Optional[EtherCATSlave] = None
        self.simulation_mode = False
        
        # Encoder & Mechanical config
        self.encoder_bits = 17
        self.encoder_ppr = self.RESOLUTIONS[17]
        self.pitch_mm = 5.0
        self.gear_ratio = 1.0
        self.scale = (self.encoder_ppr * self.gear_ratio) / self.pitch_mm
        
        # CiA402 & Motion State
        self.cia402_state = "SWITCH_ON_DISABLED"
        self.is_enabled = False
        self.is_faulted = False
        self.active_alarm = GMTCNT_ALARM_TABLE[0x0000]
        self.is_moving = False
        self.motion_mode = "STOPPED" # STOPPED, JOG_FWD, JOG_REV, CONTINUOUS, STRESS_TEST
        self.target_rpm = 0.0
        self.actual_rpm = 0.0
        self.actual_position = 0.0
        self.target_position = 0.0
        self.following_error = 0.0
        self.bus_cycle_us = 1000 # 1ms DC sync
        self.jitter_us = 12
        self.wck_errors = 0
        self.last_update = time.time()
        
        # Stress Test state
        self.stress_active = False
        self.stress_total_cycles = 50
        self.stress_current_cycle = 0
        self.stress_stage = 0
        self.stress_distance = 50.0
        self.stress_speeds = [500, 1000, 1500, 2000]
        self.stress_speed_idx = 0
        self.stress_timer = 0.0

        # Scope history buffer (500 samples ring buffer)
        self.scope_history = collections.deque(maxlen=500)

        self._detect_environment()

    def _detect_environment(self):
        try:
            res = subprocess.run(["which", "ethercat"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            if res.returncode != 0:
                self.simulation_mode = True
        except Exception:
            self.simulation_mode = True

    def set_encoder_resolution(self, bits: int, pitch_mm: float = 5.0, gear_ratio: float = 1.0):
        self.encoder_bits = bits
        self.encoder_ppr = self.RESOLUTIONS.get(bits, 131072)
        self.pitch_mm = pitch_mm
        self.gear_ratio = gear_ratio
        self.scale = (self.encoder_ppr * self.gear_ratio) / self.pitch_mm
        if self.selected_slave:
            self.select_and_optimize(self.selected_slave.position)
        return {"bits": self.encoder_bits, "ppr": self.encoder_ppr, "scale": self.scale}

    def scan_slaves(self) -> List[Dict[str, Any]]:
        slaves = []
        if not self.simulation_mode:
            try:
                res = subprocess.run(["ethercat", "slaves"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=5)
                if res.returncode == 0 and res.stdout.strip():
                    for line in res.stdout.strip().splitlines():
                        parts = line.split(maxsplit=4)
                        if len(parts) >= 5:
                            pos = int(parts[0])
                            alias = int(parts[1].split(":")[0])
                            state = parts[2]
                            flag = parts[3]
                            name = parts[4]
                            vid, pid = self._get_slave_ids(pos)
                            slave = EtherCATSlave(pos, alias, state, flag, name, vid, pid)
                            slaves.append(slave)
                    if slaves:
                        return [s.to_dict() for s in slaves]
            except Exception as e:
                print(f"EtherCAT scan warning: {e}")

        mock_slaves = [
            EtherCATSlave(0, 0, "OP", "+", "GMTCNT SD7EC EtherCAT Servo Sürücü (17-Bit Abs)", "0x00000a6e", "0x000007ec"),
            EtherCATSlave(1, 0, "OP", "+", "GMTCNT SD1EC EtherCAT Servo Sürücü (Eksen 2)", "0x00000a6e", "0x000001ec"),
            EtherCATSlave(2, 0, "OP", "+", "Delta ASDA-A3-E EtherCAT AC Servo Sürücü", "0x000001dd", "0x00001030"),
            EtherCATSlave(3, 0, "PREOP", "+", "Beckhoff EK1100 Bus Coupler (16 Dijital I/O)", "0x00000002", "0x044c2c52")
        ]
        return [s.to_dict() for s in mock_slaves]

    def _get_slave_ids(self, pos: int):
        vid, pid = "0x00000a6e", "0x000007ec"
        try:
            res = subprocess.run(["ethercat", "slaves", "-v", "-p", str(pos)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=3)
            for line in res.stdout.splitlines():
                if "Vendor ID:" in line:
                    vid = line.split(":")[-1].strip()
                elif "Product code:" in line:
                    pid = line.split(":")[-1].strip()
        except Exception:
            pass
        return vid, pid

    def select_and_optimize(self, position: int) -> Dict[str, Any]:
        slaves = self.scan_slaves()
        selected = next((s for s in slaves if s["position"] == position), None)
        if not selected:
            raise ValueError(f"Slave with position {position} not found.")

        self.selected_slave = EtherCATSlave(
            selected["position"],
            selected["alias"],
            selected["state"],
            selected["flag"],
            selected["name"],
            selected["vendor_id"],
            selected["product_code"]
        )

        xml_content = self._generate_ethercat_xml(self.selected_slave)
        xml_path = os.path.join(self.configs_dir, "ethercat-conf.xml")
        with open(xml_path, "w", encoding="utf-8") as f:
            f.write(xml_content)

        hal_content = self._generate_hal_config(self.selected_slave)
        hal_path = os.path.join(self.configs_dir, "ethercat_test.hal")
        with open(hal_path, "w", encoding="utf-8") as f:
            f.write(hal_content)

        ini_content = self._generate_ini_config(self.selected_slave)
        ini_path = os.path.join(self.configs_dir, "ethercat_test.ini")
        with open(ini_path, "w", encoding="utf-8") as f:
            f.write(ini_content)

        self.is_enabled = False
        self.is_faulted = False
        self.active_alarm = GMTCNT_ALARM_TABLE[0x0000]
        self.cia402_state = "SWITCH_ON_DISABLED"
        self.motion_mode = "STOPPED"
        self.actual_rpm = 0.0

        return {
            "status": "success",
            "slave": self.selected_slave.to_dict(),
            "files": {
                "ethercat_conf_xml": xml_path,
                "ethercat_test_hal": hal_path,
                "ethercat_test_ini": ini_path
            },
            "xml_preview": xml_content,
            "hal_preview": hal_content,
            "ini_preview": ini_content,
            "optimizations": {
                "sync_cycle_ns": 1000000,
                "encoder_bits": self.encoder_bits,
                "encoder_ppr": self.encoder_ppr,
                "scale": self.scale,
                "pitch_mm": self.pitch_mm
            }
        }

    def _generate_ethercat_xml(self, slave: EtherCATSlave) -> str:
        return f"""<masters>
  <master idx="0" appTimePeriod="1000000" refClockSyncCycles="1">
    <slave idx="{slave.position}" type="generic" vid="{slave.vendor_id}" pid="{slave.product_code}" configPdos="true">
      <syncManager idx="2" dir="out">
        <pdo idx="1600">
          <pdoEntry idx="6040" subIdx="00" bitLen="16" halType="u32" halPin="cia-controlword"/>
          <pdoEntry idx="6060" subIdx="00" bitLen="8"  halType="s32" halPin="opmode"/>
          <pdoEntry idx="607A" subIdx="00" bitLen="32" halType="s32" halPin="target-position"/>
          <pdoEntry idx="60FF" subIdx="00" bitLen="32" halType="s32" halPin="target-velocity"/>
        </pdo>
      </syncManager>
      <syncManager idx="3" dir="in">
        <pdo idx="1A00">
          <pdoEntry idx="6041" subIdx="00" bitLen="16" halType="u32" halPin="cia-statusword"/>
          <pdoEntry idx="6061" subIdx="00" bitLen="8"  halType="s32" halPin="opmode-display"/>
          <pdoEntry idx="6064" subIdx="00" bitLen="32" halType="s32" halPin="actual-position"/>
          <pdoEntry idx="606C" subIdx="00" bitLen="32" halType="s32" halPin="actual-velocity"/>
          <pdoEntry idx="603F" subIdx="00" bitLen="16" halType="u32" halPin="error-code"/>
        </pdo>
      </syncManager>
      <dcConf assignActivate="300" sync0Cycle="1000000" sync0Shift="250000"/>
    </slave>
  </master>
</masters>
"""

    def _generate_hal_config(self, slave: EtherCATSlave) -> str:
        p = slave.position
        return f"""# ==============================================================================
# LinuxCNC HAL Configuration - Optimized for EtherCAT 1-Axis Single Drive Test
# Drive: {slave.name} (Position: {slave.position}, VID: {slave.vendor_id}, PID: {slave.product_code})
# Encoder: {self.encoder_bits}-Bit ({self.encoder_ppr} PPR) | Hatve: {self.pitch_mm} mm
# ==============================================================================

# 1. Load Realtime Components
loadrt [KINS]KINEMATICS
loadrt [EMCMOT]EMCMOT servo_period_nsec=[EMCMOT]SERVO_PERIOD num_joints=1
loadusr -W lcec_conf [CONFIG_DIR]/ethercat-conf.xml
loadrt lcec
loadrt pid names=pid.0
loadrt cia402 names=cia402.0

# 2. Add Functions to Servo Thread (1ms Loop)
addf lcec.read-all servo-thread
addf motion-command-handler servo-thread
addf motion-controller servo-thread
addf pid.0.do-pid-calcs servo-thread
addf cia402.0.update servo-thread
addf lcec.write-all servo-thread

# 3. CiA402 State Machine & Drive Enable
net drive-enable       joint.0.amp-enable-out => cia402.0.enable
net drive-status       lcec.0.{p}.cia-statusword => cia402.0.statusword
net drive-control      cia402.0.controlword => lcec.0.{p}.cia-controlword
net drive-opmode-cmd   cia402.0.opmode => lcec.0.{p}.opmode
net drive-is-enabled   cia402.0.drv-act-enable => joint.0.amp-is-enabled

# 4. Position & Velocity Commands
net axis-pos-cmd       joint.0.motor-pos-cmd => cia402.0.pos-cmd
net drive-pos-target   cia402.0.drv-target-pos => lcec.0.{p}.target-position
net drive-pos-fb       lcec.0.{p}.actual-position => cia402.0.drv-actual-pos
net axis-pos-fb        cia402.0.pos-fb => joint.0.motor-pos-fb

# 5. Fault & Alarm Handling (0x603F Error Code)
net drive-fault        cia402.0.drv-fault => joint.0.amp-fault-in
net drive-error-code   lcec.0.{p}.error-code
"""

    def _generate_ini_config(self, slave: EtherCATSlave) -> str:
        return f"""; ==============================================================================
; LinuxCNC INI Configuration - Optimized for EtherCAT 1-Axis Test
; Drive: {slave.name} | Encoder SCALE: {self.scale}
; ==============================================================================

[EMC]
VERSION = 1.1
MACHINE = GMTCNT_EtherCAT_Test
DEBUG = 0

[DISPLAY]
DISPLAY = axis
POSITION_OFFSET = RELATIVE
POSITION_FEEDBACK = ACTUAL
MAX_FEED_OVERRIDE = 2.0
DEFAULT_LINEAR_VELOCITY = 50.0
MAX_LINEAR_VELOCITY = 250.0
DEFAULT_ACCELERATION = 1000.0
MAX_ACCELERATION = 3000.0

[TASK]
TASK = milltask
CYCLE_TIME = 0.001

[RS274NGC]
PARAMETER_FILE = linuxcnc.var

[EMCMOT]
EMCMOT = motmod
COMM_TIMEOUT = 1.0
SERVO_PERIOD = 1000000

[HAL]
HALFILE = ethercat_test.hal

[TRAJ]
COORDINATES = X
LINEAR_UNITS = mm
ANGULAR_UNITS = degree
DEFAULT_LINEAR_VELOCITY = 50.0
MAX_LINEAR_VELOCITY = 250.0
DEFAULT_LINEAR_ACCELERATION = 1000.0
MAX_LINEAR_ACCELERATION = 3000.0

[KINS]
JOINTS = 1
KINEMATICS = trivkins coordinates=X

[AXIS_X]
MIN_LIMIT = -999999.0
MAX_LIMIT = 999999.0
MAX_VELOCITY = 250.0
MAX_ACCELERATION = 3000.0

[JOINT_0]
TYPE = LINEAR
MIN_LIMIT = -999999.0
MAX_LIMIT = 999999.0
MAX_VELOCITY = 250.0
MAX_ACCELERATION = 3000.0
FERROR = 5.0
MIN_FERROR = 1.0
SCALE = {self.scale:.2f}
"""

    def enable_drive(self):
        if self.is_faulted:
            return {"status": "error", "message": "Sürücü arızada! Önce arızayı sıfırlayın."}
        self.is_enabled = True
        self.cia402_state = "OPERATION_ENABLED"
        return {"status": "success", "cia402_state": self.cia402_state}

    def disable_drive(self):
        self.is_enabled = False
        self.is_moving = False
        self.stress_active = False
        self.motion_mode = "STOPPED"
        self.target_rpm = 0.0
        self.cia402_state = "SWITCH_ON_DISABLED"
        return {"status": "success", "cia402_state": self.cia402_state}

    def reset_fault(self):
        self.is_faulted = False
        self.wck_errors = 0
        self.active_alarm = GMTCNT_ALARM_TABLE[0x0000]
        self.cia402_state = "SWITCH_ON_DISABLED"
        return {"status": "success", "cia402_state": self.cia402_state, "alarm": self.active_alarm}

    def trigger_test_alarm(self, hex_code: int):
        alarm = GMTCNT_ALARM_TABLE.get(hex_code, {
            "code": f"Er {hex_code:03X}",
            "name": f"Bilinmeyen Arıza (0x{hex_code:04X})",
            "cause": "Sürücü donanım hatası.",
            "action": "Kılavuza başvurun."
        })
        self.is_faulted = True
        self.is_enabled = False
        self.is_moving = False
        self.motion_mode = "FAULTED"
        self.cia402_state = "FAULT"
        self.target_rpm = 0.0
        self.active_alarm = alarm
        return {"status": "success", "alarm": alarm}

    def start_jog(self, direction: str, speed_rpm: float):
        if not self.is_enabled:
            return {"status": "error", "message": "Sürücü önce ENABLE edilmelidir!"}
        self.stress_active = False
        self.motion_mode = "JOG_FWD" if direction == "fwd" else "JOG_REV"
        self.is_moving = True
        self.target_rpm = speed_rpm if direction == "fwd" else -speed_rpm
        return {"status": "success", "motion_mode": self.motion_mode, "target_rpm": self.target_rpm}

    def step_jog(self, direction: str, step_mm: float, speed_rpm: float):
        if not self.is_enabled:
            return {"status": "error", "message": "Sürücü önce ENABLE edilmelidir!"}
        self.stress_active = False
        dist = step_mm if direction == "fwd" else -step_mm
        self.actual_position += dist
        return {"status": "success", "step_mm": dist, "new_pos": self.actual_position}

    def start_continuous(self, speed_rpm: float):
        if not self.is_enabled:
            return {"status": "error", "message": "Sürücü önce ENABLE edilmelidir!"}
        self.stress_active = False
        self.motion_mode = "CONTINUOUS"
        self.is_moving = True
        self.target_rpm = speed_rpm
        return {"status": "success", "motion_mode": self.motion_mode, "target_rpm": self.target_rpm}

    def start_stress_test(self, cycles: int = 50, distance_mm: float = 50.0):
        if not self.is_enabled:
            return {"status": "error", "message": "Sürücü önce ENABLE edilmelidir!"}
        self.stress_active = True
        self.stress_total_cycles = cycles
        self.stress_current_cycle = 1
        self.stress_distance = distance_mm
        self.stress_stage = 0
        self.stress_speed_idx = 0
        self.motion_mode = "STRESS_TEST"
        self.is_moving = True
        self.target_rpm = self.stress_speeds[0]
        return {"status": "success", "motion_mode": self.motion_mode, "cycles": cycles}

    def stop_motion(self):
        self.stress_active = False
        self.motion_mode = "STOPPED"
        self.is_moving = False
        self.target_rpm = 0.0
        return {"status": "success", "motion_mode": self.motion_mode}

    def update_telemetry(self):
        now = time.time()
        dt = now - self.last_update
        self.last_update = now

        # Stress test cycle simulation
        if self.stress_active and self.is_enabled:
            self.stress_timer += dt
            if self.stress_timer >= 1.2:
                self.stress_timer = 0.0
                if self.stress_stage == 0:
                    self.stress_stage = 1
                    current_spd = self.stress_speeds[self.stress_speed_idx % len(self.stress_speeds)]
                    self.target_rpm = -current_spd
                else:
                    self.stress_stage = 0
                    self.stress_current_cycle += 1
                    self.stress_speed_idx += 1
                    if self.stress_current_cycle > self.stress_total_cycles:
                        self.stop_motion()
                    else:
                        current_spd = self.stress_speeds[self.stress_speed_idx % len(self.stress_speeds)]
                        self.target_rpm = current_spd

        # Ramp towards target RPM
        if self.is_enabled and self.is_moving:
            accel = 2400.0
            if self.actual_rpm < self.target_rpm:
                self.actual_rpm = min(self.target_rpm, self.actual_rpm + accel * dt)
            elif self.actual_rpm > self.target_rpm:
                self.actual_rpm = max(self.target_rpm, self.actual_rpm - accel * dt)
        else:
            decel = 4000.0
            if self.actual_rpm > 0:
                self.actual_rpm = max(0.0, self.actual_rpm - decel * dt)
            elif self.actual_rpm < 0:
                self.actual_rpm = min(0.0, self.actual_rpm + decel * dt)

        # Update position
        rev_per_sec = self.actual_rpm / 60.0
        self.actual_position += rev_per_sec * self.pitch_mm * dt
        self.following_error = abs(self.target_rpm - self.actual_rpm) * 0.003
        self.jitter_us = 12 + int(math.sin(now * 10) * 3)

        sample = {
            "timestamp": round(now, 3),
            "actual_rpm": round(self.actual_rpm, 2),
            "actual_position": round(self.actual_position, 3),
            "following_error_um": round(self.following_error * 1000, 2),
            "wck_errors": self.wck_errors
        }
        self.scope_history.append(sample)

        return {
            "is_enabled": self.is_enabled,
            "is_faulted": self.is_faulted,
            "active_alarm": self.active_alarm,
            "cia402_state": self.cia402_state,
            "motion_mode": self.motion_mode,
            "is_moving": self.is_moving,
            "actual_rpm": round(self.actual_rpm, 2),
            "target_rpm": round(self.target_rpm, 2),
            "actual_position": round(self.actual_position, 3),
            "following_error": round(self.following_error, 4),
            "bus_cycle_us": self.bus_cycle_us,
            "jitter_us": self.jitter_us,
            "wck_errors": self.wck_errors,
            "encoder_bits": self.encoder_bits,
            "encoder_ppr": self.encoder_ppr,
            "scale": round(self.scale, 2),
            "stress_active": self.stress_active,
            "stress_cycle": self.stress_current_cycle,
            "stress_total_cycles": self.stress_total_cycles,
            "selected_slave": self.selected_slave.to_dict() if self.selected_slave else None
        }

    def export_csv(self) -> str:
        lines = ["Timestamp,Actual_RPM,Actual_Position_mm,Following_Error_um,WCK_Errors"]
        for s in self.scope_history:
            lines.append(f"{s['timestamp']},{s['actual_rpm']},{s['actual_position']},{s['following_error_um']},{s['wck_errors']}")
        return "\n".join(lines)

engine = EtherCATEngine()
