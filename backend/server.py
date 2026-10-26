"""
FastAPI Server & WebSocket Bridge for GMTCNT EtherCAT Test
"""

import asyncio
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from ethercat_engine import engine, GMTCNT_ALARM_TABLE

app = FastAPI(title="GMTCNT EtherCAT Test API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class SelectSlaveRequest(BaseModel):
    position: int

class EncoderConfigRequest(BaseModel):
    bits: int
    pitch_mm: float = 5.0
    gear_ratio: float = 1.0

class JogRequest(BaseModel):
    direction: str
    speed_rpm: float

class StepJogRequest(BaseModel):
    direction: str
    step_mm: float
    speed_rpm: float

class ContinuousRequest(BaseModel):
    speed_rpm: float

class StressTestRequest(BaseModel):
    cycles: int = 50
    distance_mm: float = 50.0

class TriggerAlarmRequest(BaseModel):
    hex_code: int

@app.get("/api/slaves")
def get_slaves():
    slaves = engine.scan_slaves()
    return {"slaves": slaves, "selected": engine.selected_slave.to_dict() if engine.selected_slave else None}

@app.post("/api/select-slave")
def select_slave(req: SelectSlaveRequest):
    return engine.select_and_optimize(req.position)

@app.post("/api/encoder-config")
def config_encoder(req: EncoderConfigRequest):
    return engine.set_encoder_resolution(req.bits, req.pitch_mm, req.gear_ratio)

@app.post("/api/drive/enable")
def enable_drive():
    return engine.enable_drive()

@app.post("/api/drive/disable")
def disable_drive():
    return engine.disable_drive()

@app.post("/api/drive/reset-fault")
def reset_fault():
    return engine.reset_fault()

@app.post("/api/drive/trigger-test-alarm")
def trigger_alarm(req: TriggerAlarmRequest):
    return engine.trigger_test_alarm(req.hex_code)

@app.get("/api/drive/alarm-catalog")
def get_alarm_catalog():
    return [{"hex": hex(k), "int_val": k, **v} for k, v in GMTCNT_ALARM_TABLE.items() if k != 0]

@app.post("/api/motion/jog")
def start_jog(req: JogRequest):
    return engine.start_jog(req.direction, req.speed_rpm)

@app.post("/api/motion/step-jog")
def step_jog(req: StepJogRequest):
    return engine.step_jog(req.direction, req.step_mm, req.speed_rpm)

@app.post("/api/motion/continuous")
def start_continuous(req: ContinuousRequest):
    return engine.start_continuous(req.speed_rpm)

@app.post("/api/motion/stress-test")
def start_stress_test(req: StressTestRequest):
    return engine.start_stress_test(req.cycles, req.distance_mm)

@app.post("/api/motion/stop")
def stop_motion():
    return engine.stop_motion()

@app.get("/api/scope/export-csv")
def export_scope_csv():
    csv_content = engine.export_csv()
    return Response(
        content=csv_content,
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=gmtcnt_ethercat_telemetry.csv"}
    )

@app.websocket("/ws/telemetry")
async def websocket_telemetry(websocket: WebSocket):
    await websocket.accept()
    try:
        while True:
            data = engine.update_telemetry()
            await websocket.send_json(data)
            await asyncio.sleep(0.04)  # 25 Hz
    except WebSocketDisconnect:
        pass
    except Exception:
        pass

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
