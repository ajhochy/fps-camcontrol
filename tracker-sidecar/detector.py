"""Pinned OpenCV Zoo YOLOX-s ONNX inference; no OpenCV/Torch dependency."""
import hashlib
import math
from pathlib import Path
import time

import numpy as np
from PIL import Image, ImageDraw

from model_manifest import MODEL_NAME, MODEL_SHA256, MODEL_BYTES


class ModelUnavailable(ValueError):
    pass


def verify_model(model):
    try:
        model = Path(model)
        if not model.is_file() or model.stat().st_size != MODEL_BYTES: raise ModelUnavailable('model_unavailable')
        digest = hashlib.sha256()
        with model.open('rb') as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b''): digest.update(chunk)
        if digest.hexdigest() != MODEL_SHA256: raise ModelUnavailable('model_checksum_mismatch')
    except OSError:
        raise ModelUnavailable('model_unavailable') from None
    return model


def preprocess(image):
    image = image.convert('RGB')
    width, height = image.size
    if min(width, height) <= 0: raise ValueError('invalid_image')
    ratio = min(640/width, 640/height)
    resized = image.resize((max(1, int(width*ratio)), max(1, int(height*ratio))), Image.Resampling.BILINEAR)
    padded = np.full((640, 640, 3), 114, dtype=np.float32)
    padded[:resized.height, :resized.width, :] = np.asarray(resized, dtype=np.float32)
    # Upstream Zoo uses RGB, CHW float32, raw 0..255, top-left fill114.
    return np.ascontiguousarray(padded.transpose(2, 0, 1)[None]), ratio, (width, height)


def decode(output, ratio, size, threshold=.35, nms_threshold=.45):
    values = np.asarray(output, dtype=np.float32)
    if values.shape != (1, 8400, 85) or not np.isfinite(values).all(): raise ValueError('invalid_model_output')
    scores = values[0, :, 4] * values[0, :, 5]  # COCO class0 is person.
    indices = np.flatnonzero(scores >= threshold)
    if not len(indices): return []
    # Bound NMS work even if a malformed model emits thousands of candidates.
    indices = indices[np.argsort(scores[indices])[::-1][:300]]
    grids, strides = [], []
    for stride in (8, 16, 32):
        side = 640 // stride
        xx, yy = np.meshgrid(np.arange(side), np.arange(side))
        grids.append(np.stack((xx, yy), -1).reshape(-1, 2))
        strides.append(np.full(side*side, stride))
    grid, stride = np.concatenate(grids)[indices], np.concatenate(strides)[indices, None]
    centers = (values[0, indices, :2] + grid) * stride
    wh = np.exp(np.clip(values[0, indices, 2:4], -20, 20)) * stride
    corners = np.concatenate((centers-wh/2, centers+wh/2), axis=1) / ratio
    width, height = size
    corners[:, (0, 2)] = np.clip(corners[:, (0, 2)], 0, width)
    corners[:, (1, 3)] = np.clip(corners[:, (1, 3)], 0, height)
    selected = []
    for position, (x1, y1, x2, y2) in enumerate(corners):
        if x2 <= x1 or y2 <= y1: continue
        area = (x2-x1)*(y2-y1)
        keep = True
        for previous in selected:
            px1, py1, px2, py2 = corners[previous]
            intersection = max(0, min(x2, px2)-max(x1, px1))*max(0, min(y2, py2)-max(y1, py1))
            union = area + (px2-px1)*(py2-py1) - intersection
            if union and intersection/union > nms_threshold: keep = False; break
        if keep: selected.append(position)
        if len(selected) >= 100: break
    return [dict(x=float(corners[p, 0]/width), y=float(corners[p, 1]/height),
                 w=float((corners[p, 2]-corners[p, 0])/width), h=float((corners[p, 3]-corners[p, 1])/height),
                 conf=float(min(1., max(0., scores[indices[p]])))) for p in selected]


def create_provider_session(create, available):
    if 'CoreMLExecutionProvider' in available:
        try: return create(['CoreMLExecutionProvider', 'CPUExecutionProvider']), 'CoreMLExecutionProvider'
        except Exception: pass
    return create(['CPUExecutionProvider']), 'CPUExecutionProvider'


class OnnxDetector:
    name = 'yolox-s-opencv-zoo-2022nov'

    def __init__(self, model, prefer_coreml=True):
        self.model = verify_model(model)
        import onnxruntime as ort
        options = ort.SessionOptions()
        options.log_severity_level = 4  # Native diagnostics can contain paths.
        options.intra_op_num_threads = 2
        options.inter_op_num_threads = 1
        self._create = lambda providers: ort.InferenceSession(str(self.model), sess_options=options, providers=providers)
        available = ort.get_available_providers() if prefer_coreml else ['CPUExecutionProvider']
        self.session, self.provider = create_provider_session(self._create, available)
        self._validate_metadata()
        self.inference_count = 0
        self.last_duration_ms = 0.

    def _validate_metadata(self):
        inputs, outputs = self.session.get_inputs(), self.session.get_outputs()
        if len(inputs) != 1 or inputs[0].type != 'tensor(float)' or list(inputs[0].shape) != [1, 3, 640, 640] or len(outputs) != 1 or list(outputs[0].shape) != [1, 8400, 85]:
            raise ModelUnavailable('model_metadata_mismatch')
        self.input_name = inputs[0].name

    def infer_raw(self, image):
        tensor, ratio, size = preprocess(image)
        began = time.perf_counter()
        try: output = self.session.run(None, {self.input_name: tensor})[0]
        except Exception:
            if self.provider == 'CPUExecutionProvider': raise ModelUnavailable('inference_failed') from None
            self.session = self._create(['CPUExecutionProvider'])
            self.provider = 'CPUExecutionProvider'
            self._validate_metadata()
            output = self.session.run(None, {self.input_name: tensor})[0]
        self.last_duration_ms = (time.perf_counter()-began)*1000
        self.inference_count += 1
        if output.shape != (1, 8400, 85) or not np.isfinite(output).all(): raise ModelUnavailable('invalid_model_output')
        return output, ratio, size

    def detect(self, image):
        output, ratio, size = self.infer_raw(image)
        return decode(output, ratio, size)


class StubDetector:
    name, provider = 'synthetic-stub', 'none'
    def __init__(self, detections): self.detections = detections
    def detect(self, image): return [dict(box) for box in self.detections]


def verify_inference(model):
    detector = OnnxDetector(model)
    images = [Image.new('RGB', (640, 480), (114, 114, 114)), Image.new('RGB', (640, 480), (10, 40, 90))]
    draw = ImageDraw.Draw(images[1])
    draw.ellipse((250, 50, 330, 130), fill=(220, 160, 120))
    draw.rectangle((245, 130, 335, 320), fill=(180, 30, 30))
    draw.rectangle((245, 320, 280, 460), fill=(30, 30, 30))
    draw.rectangle((300, 320, 335, 460), fill=(30, 30, 30))
    durations, digests, counts = [], [], []
    for image in images:
        output, ratio, size = detector.infer_raw(image)
        durations.append(detector.last_duration_ms)
        digests.append(hashlib.sha256(output.tobytes()).hexdigest())
        counts.append(len(decode(output, ratio, size)))
    return dict(modelSha256=MODEL_SHA256, provider=detector.provider, inferenceCount=detector.inference_count,
                shape=list(output.shape), finite=True, inputDependent=digests[0] != digests[1],
                detectP50Ms=sorted(durations)[0], detectP95Ms=max(durations), fps=2000/sum(durations),
                frameAgeMs=max(durations), personCounts=counts, fixture='generated RGB only; not accuracy proof',
                timingScope='inference only; not source transport or camera exposure latency')
