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
6002(`pocketRisu` 순정 인스턴스)와 홈 화면/탭에서 구별되도록 초록 색조본을 쓴다.
로고 형태는 그대로 두고 휘도 보존 hue-rotate 만 적용한 것.

재생성은 `pocketRisu/web/gen_tinted.py` 가 두 인스턴스 것을 한 번에 뽑는다:

    cd ../pocketRisu/web && python3 gen_tinted.py
    cp out/6001-green/*.png ../../risuai-nodeonly-llm-proxy/custom-manifest/icons/

`logo_maskable_*` 은 런처가 임의 모양으로 잘라내는 걸 감안해 로고를 중앙 80%
safe zone 에 넣고 배경 그라디언트를 바깥까지 연장한 버전이다.

## HTTPS
안드로이드 Chrome 은 secure context 에서만 앱 설치를 허용한다. 이 인스턴스는
아직 tailscale serve 에 등록돼 있지 않아 폰에서 설치가 안 된다. 필요하면:

    tailscale serve --bg --https=6001 http://127.0.0.1:6001
