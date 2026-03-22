# Threads Media Downloader

Threads 게시물에서 **사진 + 동영상**을 다운로드하는 크롬 확장프로그램입니다.

## 설치

1. Chrome에서 `chrome://extensions` 열기
2. **개발자 모드** 켜기
3. **압축해제된 확장 프로그램을 로드합니다** 클릭
4. `threads-video-downloader` 폴더 선택

## 사용법

### 방법 1: 미디어 위에서 직접 다운로드
- 사진이나 영상 위에 마우스를 올리면 **Download** 버튼 표시
- 클릭하면 바로 다운로드

### 방법 2: 팝업에서 일괄 다운로드
- 확장 아이콘 클릭 → 발견된 모든 미디어 목록 표시
- 개별 Save 또는 **모두 다운로드** 가능

## 동작 방식

| 전략 | 설명 |
|------|------|
| 네트워크 인터셉트 | CDN 요청을 실시간 캡처 (blob: URL 우회) |
| SSR JSON 파싱 | `video_versions` / `image_versions2` 데이터 추출 |
| Embed 폴백 | `/post/{id}/embed` 페이지에서 직접 URL 추출 |

## 향후 계획

- Instagram 사진/동영상 다운로드 통합 지원
