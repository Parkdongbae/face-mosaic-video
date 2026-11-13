# LICENSES — 이 앱이 쓰는 모델·런타임·라이브러리

이 저장소의 소스 코드는 MIT 라이선스입니다(`LICENSE`).
아래는 저장소에 들어 있지 않고 `npm install`, `npm run assets` 로 받아 쓰는 것들의 출처와 라이선스 기록입니다.
"확인" 칸은 이 저장소에서 직접 확인한 근거를 적습니다. 근거가 없는 항목은 **미확인**으로 둡니다.

## 기본으로 받는 것 (`npm run assets`)

### 얼굴 검출 모델 (`public/models/`)

| 파일 | 출처 | 라이선스 | 확인 |
| --- | --- | --- | --- |
| `face_detection_yunet_2023mar.onnx` (앱이 쓰는 모델) | OpenCV Zoo (`opencv/opencv_zoo`, models/face_detection_yunet) | MIT | 내려받기 스크립트 기록. 저장소 LICENSE 원문 미확인 |
| `blaze_face_short_range.tflite` (개발용 비교 화면 전용, 배포본에서 제외) | Google MediaPipe 모델 저장소 (storage.googleapis.com/mediapipe-models) | Apache-2.0 | 내려받기 스크립트 기록. 모델 카드 원문 미확인 |
| `blaze_face_full_range.tflite` (개발용 비교 화면 전용, 배포본에서 제외) | 위와 같음 | Apache-2.0 | 내려받기 스크립트 기록. 모델 카드 원문 미확인 |

### 런타임 (`public/wasm/`)

| 경로 | 패키지 | 라이선스 | 확인 |
| --- | --- | --- | --- |
| `wasm/ort/` | `onnxruntime-web` 1.31.1 | MIT | 설치된 package.json |
| `wasm/tasks-vision/` (개발용 비교 화면 전용, 배포본에서 제외) | `@mediapipe/tasks-vision` 1.2.3 | Apache-2.0 | 설치된 package.json |

## 기본으로 받지 않는 것 (쓰는 사람이 직접 설치)

라이선스 조건 때문에 저장소·기본 설치·기본 배포본에 넣지 않습니다. 설치 방법은 `README.md` 하단에 있습니다.

| 항목 | 설치 명령 | 라이선스 | 넣지 않는 이유 |
| --- | --- | --- | --- |
| ffmpeg.wasm 실행 파일 `@ffmpeg/core` 0.12.10 (x264 포함) → `public/wasm/ffmpeg/` | `npm run assets:ffmpeg` | **GPL-2.0-or-later** (설치된 package.json 에서 확인) | GPL 프로그램이라, 이 파일을 포함해 배포하면 GPL 의무(라이선스 고지, 소스 코드 제공 등)가 배포하는 사람에게 생깁니다. |
| SCRFD 모델 `scrfd_10g_gnkps_fp32.onnx` → `public/models/` | `npm run assets:scrfd` | **미확인** | HuggingFace 미러(`kunkunlin1221/face-detection_scrfd-10g-gnkps`)에서 받으며 사용 조건의 근거를 확인하지 못했습니다. 원본인 InsightFace 는 사전 학습 모델을 비상업 연구용으로 제한한다고 알려져 있습니다. 개발용 비교 화면에서만 쓰고 앱은 쓰지 않습니다. |

## 앱에 함께 묶이는 라이브러리

| 패키지 | 용도 | 라이선스 | 확인 |
| --- | --- | --- | --- |
| `mediabunny` 1.65.2 | 영상 파일 분해·결합, 해독·압축 연결 | MPL-2.0 | 설치된 package.json |
| `@ffmpeg/ffmpeg` 0.12.15 | ffmpeg.wasm 을 부르는 래퍼(실행 파일은 들어 있지 않음) | MIT | 설치된 package.json |
| `qrcode-generator` 2.0.4 | QR 코드 생성 | MIT | 설치된 package.json |
| `react`, `react-dom` 19.3.1 | 화면 | MIT | 설치된 package.json |

## 개발·시험 도구

| 항목 | 용도 | 라이선스 | 비고 |
| --- | --- | --- | --- |
| `ffmpeg-static` 5.3.0 | 시험 영상 만들기(`npm run fixtures`) | 패키지는 GPL-3.0-or-later, 내려받는 ffmpeg 실행 파일도 GPL | 개발자 컴퓨터에서만 쓰며 앱·배포본에 들어가지 않습니다. |
| `playwright`, `vite`, `vitest`, `typescript` 등 | 빌드·시험 | 각 패키지의 라이선스 | 앱·배포본에 들어가지 않습니다. |

## 시험 사진 (`tests/fixtures/photos/raw/`)

Wikimedia Commons 의 CC0 사진 9장을 `npm run assets` 로 받습니다(저장소에는 넣지 않음). 작가·원본 주소는 `tests/fixtures/photos/credits.json` 에 기록되어 있습니다(Commons API 가 돌려준 라이선스 값 기준).
시험 영상은 이 사진들을 합성해 만듭니다. 실제 학생 영상은 저장소에 넣지 않습니다.
