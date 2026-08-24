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
Windows 호스트의 Tailscale 로 노출돼 있다 (Windows 56001 → WSL 6001 포워딩 경유):

    https://okarin-pc-2023.tail2f4a72.ts.net:56001/     # 6001, 이 스택
    https://okarin-pc-2023.tail2f4a72.ts.net:56002/     # 6002, pocketRisu

## ⚠️ 제약 — 안드로이드에서는 둘 중 하나만 설치된다

포트가 다르면 웹 표준상 origin 이 다르지만, **안드로이드 설치 레벨에서는 그게
유지되지 않는다.** Chrome 이 PWA 설치 시 만드는 WebAPK 의 intent filter 는

    <data android:scheme="https" android:host="..." android:pathPrefix="/" />

이 셋뿐이고 **포트 속성이 없다**. 그래서 `:56001` 로 설치한 WebAPK 가 `:56002` 도
자기 영역으로 잡는다. 하나를 설치한 뒤 나머지를 크롬으로 열면 설치 버튼 대신
"○○에서 열기" 가 뜨는 게 이 증상이다 (실측 확인).

여기서 만든 id·short_name·아이콘 구분은 브라우저 탭과 데스크톱 설치, 그리고
실제로 설치된 쪽의 홈 화면 표시에는 유효하지만, 두 번째 앱이 설치되지 않는 문제
자체는 해결하지 못한다. 풀려면 host 를 갈라야 한다 (tailscale 사이드카로 전용
노드 이름 부여 등). 자세한 내용은 pocketRisu/web/README.md.
