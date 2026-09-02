# custom-manifest/ — PWA 오버라이드

`/app/dist/manifest.json` 과 아이콘을 read-only bind mount 로 덮어쓴다
(docker-compose.yml 의 volumes 참고). 이미지는 다시 빌드하지 않아도 된다.

## manifest.json
upstream 원본 대비:
- `name` = `PC2 Risuai`, `short_name` = `PC2 Risu`
  (홈 화면 라벨은 10자 넘으면 잘린다)
- `id` = `/` — 없으면 `start_url` 이 암묵적 id 가 되어, 나중에 `start_url` 을
  바꾸면 기존 설치와 별개 앱으로 인식돼 홈 화면에 아이콘이 하나 더 생긴다
- `scope`, `description`, `lang`, `dir`, `background_color` 추가
  (`background_color` 가 없으면 스플래시가 흰색으로 번쩍인다)
- `theme_color` 는 upstream 기본값 `#4682B4` 유지 — 6002 순정 인스턴스가
  `#282a36` 이라, 달라야 실행 중 상태바 색으로도 구분된다
- 아이콘 `src` 절대경로 + `purpose` 명시, maskable 2종 추가
- `share_target`, `file_handlers` 는 기존 그대로

## icons/
6002(`pocketRisu` 순정 인스턴스)와 브라우저 탭/홈 화면에서 구별되도록 초록 색조본을
쓴다. 로고 형태는 그대로 두고 휘도 보존 hue-rotate 만 적용한 것.
**단 이것만으로 안드로이드에서 두 앱이 따로 설치되지는 않는다 — 아래 제약 참고.**

재생성은 `pocketRisu/web/gen_tinted.py` 가 두 인스턴스 것을 한 번에 뽑는다:

    cd ../pocketRisu/web && python3 gen_tinted.py
    cp out/6001-green/*.png ../../risuai-nodeonly-llm-proxy/custom-manifest/icons/

`logo_maskable_*` 은 런처가 임의 모양으로 잘라내는 걸 감안해 로고를 중앙 80%
safe zone 에 넣고 배경 그라디언트를 바깥까지 연장한 버전이다.

## HTTPS / 접속 주소
안드로이드 Chrome 은 secure context 에서만 앱 설치를 허용한다. 이 인스턴스는
Windows 호스트의 Tailscale 로 노출돼 있다 (Windows 56001 → WSL 6001 포워딩 경유).

| | PWA 설치 주소 | 루트 |
|---|---|---|
| 6001, 이 스택 | `https://okarin-pc-2023.tail2f4a72.ts.net:56001/poketrisu1/` | `:56001/` |
| 6002, pocketRisu | `https://okarin-pc-2023.tail2f4a72.ts.net:56002/poketrisu2/` | `:56002/` |

## 왜 경로(`/poketrisu1/`)로 설치하는가

포트만 다르면 안드로이드가 두 앱을 구분하지 못한다. Chrome 이 PWA 설치 시 만드는
WebAPK 의 intent filter 가 scheme/host/pathPrefix 뿐이고 **포트가 없기** 때문이다.
하나를 설치한 뒤 나머지를 열면 설치 버튼 대신 "○○에서 열기" 가 뜬다 (실측 확인).

`pathPrefix` 는 filter 에 들어가므로 경로를 갈라 해결한다. 단 **형제 관계**여야 한다 —
한쪽을 `/` 에 두면 그게 바깥 앱이 되어 다른 쪽까지 삼키므로, 6002 와 함께 옮겼다.
manifest 의 `id`·`scope`·`start_url` 셋을 모두 그 경로로 맞춘다.

경로는 tailscale serve 의 `--set-path` 가 접두어를 벗겨 백엔드 `/` 로 넘겨서 만든다.
정적 파일이나 심볼릭 링크로는 안 되는데, 서버의 `app.get('/')` 핸들러가 index.html 에
`__NODE__` 를 주입하고 `express.static` 경로로는 그게 빠지기 때문이다.

설정 재현: `pocketRisu/web/setup-tailscale-serve.sh` (양쪽을 한 번에 잡는다)

## 상태

serve 매핑과 manifest 는 적용 완료. **안드로이드에서 두 앱이 실제로 따로 설치되는지는
아직 실측 전이다** — 기존에 설치된 앱(scope `/`)을 먼저 지워야 새 경로들이 산다.
자세한 배경은 pocketRisu/web/README.md.
