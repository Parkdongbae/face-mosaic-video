/**
 * 사양 점검 기준값. PRD 의 값은 초안이며 학교 컴퓨터 시험 후 조정한다(glm.md 5장·9장).
 * 기준을 바꿀 때는 이 파일만 고친다.
 */
export const SPEC_THRESHOLDS = {
  cores: { min: 4, recommended: 8 },
  /** navigator.deviceMemory 는 크롬 계열에서만 나오고 8 에서 잘린다. */
  memoryGb: { min: 4, recommended: 8 },
  /** 저장 공간: 영상 용량의 몇 배가 비어 있어야 하는지 */
  storageMultiple: { min: 2, recommended: 3 },
  /** 검출 속도(초당 처리 장수) */
  detectFps: { min: 5, recommended: 15 },
  /** 예상 처리 시간이 영상 길이의 이 배수를 넘으면 부적합 */
  maxProcessRatio: 10,
  /** 검출 속도 벤치마크에 쓰는 시험 프레임 */
  benchmark: { frames: 30, width: 1280, height: 720 },
  /** 영상을 불러오기 전에 예상 시간을 보여 줄 때 가정하는 영상 */
  referenceVideo: { durationSec: 600, fps: 30, width: 1920, height: 1080 },
} as const
