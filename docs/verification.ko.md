# 공개본 검증 가이드

이 문서는 공개 TypeScript 어댑터 자체를 검증하는 방법만 설명한다. 고객 이미지, 고객 prompt, 브랜드·제품 분석값, 원격 provider task ID와 사내 결과물은 포함하지 않는다.

## 실행

```sh
pnpm install
pnpm typecheck
pnpm test
```

## 검증 범위

### 1. Reference role / swap

- 이미지 순서와 `IMAGE N` 매핑이 안정적으로 유지되는지 확인한다.
- 각 reference가 명시된 role 밖의 속성을 공급하지 못하게 한다.
- 최종 제품 상태와 부품별 attribute 귀속 계약을 prompt에 포함한다.
- 고객 입력과 서버가 추가하는 내부 role/state contract를 분리한다.

생성 결과의 실제 상태·동작을 판별하는 vision classifier는 이 패키지에 포함하지 않는다. 해당 평가는 호스트의 별도 QA 또는 수동 검수 책임이다.

### 2. Composite / outpaint

- canonical RGBA에는 uniform scale과 translation만 적용한다.
- `strict`에서 최종 opaque foreground가 resized canonical과 byte-identical인지 확인한다.
- `ambient`에서 alpha·bbox·W/H가 유지되고 RGB 변화가 ΔE00 budget 안인지 확인한다.
- foreground 뒤에만 procedural shadow를 만들고 최종 canonical layer를 마지막에 합성한다.
- background의 camera/support geometry가 맞지 않으면 결과를 변형하지 않고 재시도를 권고한다.
- `outpaint`에서는 저장된 정수 좌표에 exact canonical layer를 다시 올리고 raw boundary drift를 측정한다.

### 3. Dieline

- 입력 도면을 늘이지 않고 1:1 흰색 canvas에 padding한다.
- TypeScript Lanczos 결과가 기준 리샘플링과 pixel-compatible한지 snapshot으로 확인한다.
- 닫힌 silhouette mask, bbox, W/H, overlay, IoU 계산을 검증한다.
- 기본 acceptance는 `abs(W/H error) <= 1%`, `silhouette IoU >= 0.99`다.

## 공개 test fixture 원칙

- fixture는 코드에서 생성한 도형과 색상만 사용한다.
- 실제 브랜드명, 로고, 패키지 문구, 고객 prompt, 고객 URL을 넣지 않는다.
- provider credential은 환경변수로만 주입하며 repository에 저장하지 않는다.
- 원격 생성 품질은 확률적이므로 unit test는 deterministic 전처리·후처리·QA 계약만 보장한다.
