# Air Drawing MVP 仕様

## 目的
PCのWebカメラ映像に、人差し指または鼻先の動きを赤線で重ね描きする静的Webアプリ。処理はブラウザ内のみで行う。

## 要件
- HTML5/CSS/Vanilla JSのみ。バックエンド・DB・フレームワーク・追加機能なし。
- `getUserMedia`でカメラを表示。映像とCanvasの表示領域全体を左右反転し、座標を一致させる。
- 速い指の動きに追従するため、640×480・60fpsを希望し、認識はGPUを優先（初期化失敗時はCPU）。ジェスチャー判定と線の連続性を維持する。
- MediaPipe Hand Landmarkerで片手のみ認識。左右どちらも対応。
- 人差し指が伸び、中指・薬指・小指が曲がっている間だけ描画。親指は無視。判定はランドマークから行う。
- 人差し指先をCanvasに描画。色 `#EA4756`、太さ5px固定。線は保持し、ジェスチャー再開時は新しい線として開始する。
- 指を下ろす、手を見失う、認識失敗時は描画を停止し、再開時に離れた線をつながない。
- リロードで描画を消す。永続化・リセットボタンなし。
- UIは画面いっぱいの映像と透明Canvas中心。起動・エラー時のみ簡潔な表示。PC/Chrome優先。HTTPS/localhostで利用。
- カメラ拒否・モデル読込失敗を表示。映像・顔や手のランドマークを外部送信しない。外部通信は静的ライブラリ・WASM・モデルのダウンロードのみ。

## 受け入れ確認
ページ表示、カメラ許可後の映像、映像とCanvas全体の左右反転と座標一致、指ジェスチャーでの開始/停止、速い動きでの赤線追従と保持、線の分離、手の再認識、リロード時の消去、静的配信可能性を確認する。

## 鼻ページ
- `dist/nose.html` と専用の `dist/nose.js` を追加し、`style.css` を共有。指ページの `app.js` とジェスチャー動作は維持する。
- 指ページから鼻ページへ、鼻ページから指ページへ明確なリンクを置く。ナビゲーション・状態表示は反転するステージの外側に置き、読みやすさを保つ。
- MediaPipe Tasks Vision 0.10.14 の既存ES module/WASMを使用。`FaceLandmarker`、`runningMode: 'VIDEO'`、`numFaces: 1`、鼻先は `faceLandmarks[0][1]`。blendshapesと変換行列の出力は無効。
- モデルは[公式Web JavaScriptガイド](https://developers.google.com/edge/mediapipe/solutions/vision/face_landmarker/web_js)から辿れる[公式モデル一覧](https://developers.google.com/edge/mediapipe/solutions/vision/face_landmarker/index#models)の直接リンクを使用する: `https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task`。`latest` は更新される可能性がある。
- 指ページと同じカメラ制約（前面、640×480・60fpsの希望値、音声なし）、GPU優先・初期化失敗時CPU。検出・存在・追跡の信頼度しきい値は0.5。
- 全画面内に縦横比を維持した映像と透明Canvasを重ね、共通ステージを1回左右反転する。鼻先の正規化座標は二重反転しない。
- 顔がある間、鼻先を赤色 `#EA4756`・表示上5pxで描く。顔消失、不正座標、ページ非表示、認識失敗、映像停止、250msを超える間隔で線を切る。再開時は別の線にする。
- 線は正規化座標でメモリに保持し、リサイズで再描画。線幅は画素密度によらず5px。リロードで消す。ページ離脱・カメラ切断・致命的エラーではカメラと認識リソースを解放する。
- 鼻ランドマーク描画、座標整合、線の停止/再開、リサイズ、エラー処理、双方向リンクを自動テストする。実機未確認の範囲はREADMEに明記する。
