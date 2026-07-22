# 문제 2 기술 판단 — CPU-only harmonization

검토일: 2026-07-22

## 결론

Aeolo/Vercel 기본 lane은 학습형 harmonizer나 segmentation GPU service를 추가하지 않는다. KIE는 제품 없는 background plate만 만들고, Node/Sharp(libvips)가 누끼 분석·색변환·배치·그림자·QA를 수행한다.

장면 문맥이 제품 바로 주변의 접지와 그림자를 직접 만들어야 할 때만 선택형 `outpaint`를 쓴다. 이 경로도 로컬 GPU는 필요 없으며 KIE가 장면을 확장하고 Node/Sharp가 exact canonical re-overlay와 QA를 수행한다. 기본 `composite`를 대체하지 않는다.

두 color mode를 제공한다.

| mode | 제품 RGB | geometry/alpha | 용도 |
| --- | --- | --- | --- |
| `strict` | canonical 그대로, ΔE00 0 | uniform scale + translation만 | 라벨·브랜드 컬러 절대 충실 |
| `ambient` | 배치 지점의 WB/노출로 제한 보정 | strict와 동일 | 약한 공간 색감 통일을 명시적으로 허용한 경우 |

`outpaint`는 color mode가 아니라 별도 생성 전략이다. 제품이 들어간 흰 캔버스를 KIE에 보내므로 raw 제품 재생성 위험이 있고, callback에서 저장된 canonical layer를 같은 좌표에 덮어 최종 opaque pixel을 복원한다. 이 경로도 `strict`가 기본이며, `ambient`를 명시하면 raw의 제품 사각형을 제외한 접지부 주변색을 읽어 같은 bounded transform을 canonical layer에 적용한 뒤 마지막에 덮는다. KIE raw가 만든 제품 밖 접지·cast shadow는 유지된다.

## 왜 단순 Reinhard full match를 기본값으로 쓰지 않는가

[Reinhard et al., Color Transfer between Images](https://research-information.bris.ac.uk/en/publications/color-transfer-between-images/)는 색 통계를 옮기는 가벼운 방법이다. 그러나 전체 전경과 전체 배경의 평균·표준편차를 그대로 맞추면 고유한 패키지 블루나 라벨 흰색까지 장면 통계로 이동할 수 있다.

현재 `ambient`는 다음처럼 더 좁게 적용한다.

1. 제품이 놓일 국소 support-plane ROI에서 neutral-like pixel만 샘플링한다.
2. canonical의 neutral sample과 비교해 bounded linear-RGB gain을 구한다.
3. 채도가 높은 브랜드 색은 gain을 약화한다.
4. 라벨 글자·윤곽·antialias처럼 고주파인 pixel은 gain을 추가로 약화한다.
5. alpha는 변경하지 않는다.
6. 평균/P95 CIEDE2000 budget을 넘으면 적용 strength를 이진 탐색으로 줄인다.
7. 의도된 변화와 합성 중 비의도 변화를 별도 수치로 기록한다.

`ambient`는 명시적으로 선택하는 mode이므로 기본 요청 strength는 `1.0`이다. 이는 무제한 full match가 아니다. linear-RGB gain 자체를 채널별 `0.84..1.18`로 제한하고, 채도/고주파 보호를 거친 다음 평균/P95 ΔE00 예산을 넘으면 실제 strength를 자동 감쇠한다. 브랜드 색을 한 픽셀도 바꾸면 안 되는 작업은 계속 `strict`를 사용한다.

## 학습형 harmonizer를 넣지 않은 이유

[PCT-Net (CVPR 2023)](https://openaccess.thecvf.com/content/CVPR2023/html/Guerreiro_PCT-Net_Full_Resolution_Image_Harmonization_Using_Pixel-Wise_Color_Transformations_CVPR_2023_paper.html)은 저해상도 입력에서 pixel-wise affine color-transform parameter를 예측하고 원해상도에 적용한다. affine color transform이 효율적이라는 근거는 되지만, parameter network inference와 model packaging이 필요하다.

현재 요구는 Vercel Node에서 낮은 운영 부담과 canonical fidelity가 우선이므로, 학습형 모델 대신 작은 bounded transform을 쓴다. 이후 별도 GPU/ONNX inference service를 운영할 이유가 생길 때만 PCT-Net/Harmonizer 계열을 비교한다.

## ΔE00

CIEDE2000 구현은 [Sharma, Wu, Dalal의 implementation notes와 test data](https://www.ece.rochester.edu/~gsharma/ciede2000/)를 기준으로 한다. QA는 두 값을 분리한다.

- `color.intendedChangeFromCanonical`: ambient가 의도적으로 바꾼 색
- `opaqueCore`: 최종 합성본 제품 core와 의도한 render layer의 차이. strict/ambient 모두 0이어야 한다.

## 광원과 그림자

- canonical: material-colored opaque pixel의 low-frequency luma로 광원 방향/softness/WB를 추정한다.
- background global: 방향, WB, 노출을 읽는다.
- background local: 제품 landing zone만 다시 읽어 hard/soft를 판정한다. 전체 장면의 수건·고글·가구 edge를 hard shadow로 오인하지 않는다.
- shadow: canonical alpha를 눌러 만든 broad cast shadow, bottom footprint contact shadow, 2px 이상 초밀착 occlusion core를 제품 뒤에 합성한다. 방향·blur·opacity는 local light quality에, shadow RGB는 local neutral sample에 맞춘다.

## 초점은 배경 생성에서 해결

제품을 합성한 뒤 sharpen/deblur하면 제품과 라벨 픽셀 계약을 불필요하게 위험하게 만든다. composite lane은 KIE가 만드는 empty plate 자체에 다음을 요구한다.

- focus-stacked / effectively infinite depth of field
- no bokeh, no selective focus, no foreground/background defocus
- 모든 거리 평면의 edge와 texture를 생성 픽셀에서 선명하게 표현
- 먼 풍경 대신 support 바로 뒤의 seamless wall/fabric/backdrop을 우선하는 depth-safe staging
- 중앙 backdrop의 rail·seam·ledge를 금지해 지지면 검출의 가짜 수평선을 줄임

no-bokeh 문구만 더 강하게 반복해도 원거리 요소의 defocus가 계속 생길 수 있었다. 가까운 depth-safe backdrop으로 장면 구조를 바꾸면 원거리 흐림을 줄일 수 있다. 이는 생성 단계의 해결이며 로컬 focus 보정은 하지 않는다. 현재 focus 판정은 육안 검증이다. 단순 Laplacian/edge score는 무늬 없는 선명한 벽과 흐린 저주파 배경을 안정적으로 구분하지 못하므로 자동 gate를 구현했다고 주장하지 않는다.

## 화각과 warp

고립된 누끼 한 장에서는 focal length(mm)를 식별할 수 없다. 대신 alpha silhouette의 좌우 대칭, 상/중/하 폭 변화, edge parallelism, roll로 frontal/angled projection class만 구한다. background prompt와 QA는 이 class에 호환되는 optical axis와 shallow support plane을 요구한다.

[OpenCV warpPerspective 문서](https://docs.opencv.org/master/da/d54/group__imgproc__transform.html)는 perspective transform이 destination pixel을 source에서 역매핑하고 interpolation하는 geometric resampling임을 보여준다. 즉 2D warp를 쓰는 순간 라벨 픽셀과 W/H 불변 계약은 끝난다. 또한 3D 패키지의 새 시점은 front cutout의 평면 homography만으로 물리적으로 복원되지 않는다.

따라서 현재 strict/ambient 3D-product lane은 warp하지 않는다. background camera/support QA 실패 시 빈 배경을 재생성한다. destination quad가 의미 있는 평면 라벨·포스터 자산은 별도 mode로 만들고, 그 mode에서는 OCR/geometry 허용 오차를 새로 정의해야 한다.

## 서버 비용

[libvips](https://www.libvips.org/)는 demand-driven, threaded, low-memory image processing을 목표로 한다. 현재 구현은 Sharp/libvips와 작은 TypeScript pixel loop만 사용하고 GPU, torch, OpenCV, SAM을 요구하지 않는다.

1K live plate에서 callback 후처리는 대체로 단건 수백 ms였다. provider background 생성은 약 30~63초였으므로 병목은 로컬 harmonization이 아니라 KIE generation이다.
