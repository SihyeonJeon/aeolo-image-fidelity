# Python 실험 원본

TypeScript production adapter로 옮기기 전에 실제 smoke에 사용한 Python/Pillow/numpy 구현을 보존한 폴더다.

| 파일 | 용도 |
| --- | --- |
| `harmonize_pipeline.py` | 누끼 광원 분석, empty plate 생성, 결정론적 합성 |
| `harmonize_size_lanes.py` | measured/semantic 두 크기 lane과 화각 QA |
| `dieline_inpaint.py` | 도면 패딩, prompt compile, KIE 실행, QA |
| `dieline_overlay.py` | 실제 도면의 흰색을 투명화한 overlay |
| `measure.py` | W/H·색·도면 overlay 실험 도구 |

의존성:

```sh
python3 -m venv .venv
source .venv/bin/activate
pip install pillow numpy
```

KIE를 호출하는 CLI는 `KIE_API_KEY` environment 또는 같은 폴더의 `.env`를 읽는다. 공개본에는 당시 token을 넣지 않았다.

```sh
export KIE_API_KEY='...'
```

주의:

- 이 파일들은 원 실험 workspace의 `refs/`, `data/`, `out/` 상대경로를 전제로 한다.
- 독립 실행 시 입력 경로를 CLI argument로 넘기거나 상수를 조정해야 한다.
- production 정본은 저장소 `src/`의 TypeScript다. Python 파일은 provenance, 수치 비교, Python batch fallback용이다.
- GPU, OpenCV, SAM, rembg, torch는 필요 없다.
