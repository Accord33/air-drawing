# Air Drawing MVP

SPEC.md に基づく、HTML/CSS/Vanilla JS の静的アプリです。指ページでは、人差し指を伸ばし、中指・薬指・小指を曲げている間だけ、人差し指先に赤い線（`#EA4756`、表示上 5px）を描きます。親指は判定しません。左右どちらの手も使え、同時に認識するのは片手です。鼻ページでは、顔を認識している間に鼻先を追って描画します。

## ローカルで開く

```sh
python3 -m http.server 8000 --bind 127.0.0.1 --directory dist
```

PC の Chrome で `http://localhost:8000`（指）または `http://localhost:8000/nose.html`（鼻）を開き、カメラを許可してください。画面左下のリンクで両ページを行き来できます。リンクと状態表示は左右反転しません。公開環境では HTTPS が必要です。ファイルを直接開く方法は使いません。

映像と透明 Canvas を共通の表示領域ごと左右反転し、縦横比を保って画面内に最大表示します。余白は黒色です。描画座標は元の映像座標を使うため、反転後も指先と線が一致します。手を下ろす・見失う・認識に失敗する場合は線を切り、再認識後は新しい線を始めます。線は画面サイズを変えても保持され、リロードで消えます。保存、リセットボタン、バックエンド、DB はありません。

速い動きへの追従のため、カメラには 640×480・60fps を希望値として指定します。実際の解像度とフレームレートはカメラ・ブラウザーによります。認識は GPU を優先し、初期化に失敗した場合は CPU に切り替えます。ジェスチャー判定のしきい値、指先座標、赤色・表示上 5px の線幅は維持しています。

## 配信するファイル

配信対象は `dist/` の以下の5ファイルです。ビルドや依存パッケージのインストールは不要です。

- `index.html`
- `app.js`
- `nose.html`
- `nose.js`
- `style.css`

環境設定や秘密情報は配信対象に含みません。

MediaPipe Tasks Vision **0.10.14** の ES module / WASM を jsDelivr から、Hand Landmarker **float16/1** モデルを Google の静的ストレージから読み込みます。初回起動時はインターネット接続とこれらの配信元へのアクセスが必要です。カメラ映像・ランドマークの解析と描画はブラウザ内で行い、映像・顔や手のランドマークを外部送信しません。鼻ページも同じライブラリ/WASMのバージョンを利用し、Face Landmarker モデルだけを追加でダウンロードします。モデルの読込失敗やカメラ拒否は画面に表示します。

## 鼻で描くページ

`nose.html` と専用の `nose.js` は、既存の `style.css` を共有します。指ページの認識処理 `app.js` は変更していません。顔が認識されている間、`faceLandmarks[0][1]`（鼻先）の移動に沿って `#EA4756`・表示上5pxの線を描きます。MediaPipe `FaceLandmarker` は `VIDEO` モード・最大1顔、GPU優先・初期化失敗時CPU。カメラは指ページと同じ640×480・60fpsの希望値、前面カメラ、音声なしです。

カメラ映像と透明Canvasを共通のステージで1回だけ左右反転し、元の映像の正規化座標をそのまま描くため、鼻先と線の位置が一致します。顔の消失、不正な座標、認識エラー、ページ非表示、映像停止、250msを超える取得間隔では線を切り、再開時は別の線を始めます。画面サイズ・画素密度が変わっても正規化座標から既存の線を再描画し、線幅5pxを維持します。リロードで線は消え、ページを離れるとカメラと認識を停止します。

モデルと設定は[公式Web JavaScriptガイド](https://developers.google.com/edge/mediapipe/solutions/vision/face_landmarker/web_js)と[公式モデル一覧](https://developers.google.com/edge/mediapipe/solutions/vision/face_landmarker/index#models)を参照しました。使用するURLはモデル一覧から直接リンクされている[FaceLandmarker float16/latest](https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task)です。HTTP 200応答を確認済みです。`latest` は配信元で更新され得ます。ライブラリ/WASMは既存と同じ0.10.14に固定しています。

## 確認

```sh
node --check dist/app.js
node --check dist/nose.js
CHROMIUM_BIN=/path/to/chromium node --experimental-vm-modules --test tests/*.test.cjs
git diff --check
```

自動テストは指・鼻の描画、線の停止/再開、リサイズ、エラー処理などを確認します。

Chromiumでは両方の実際のHTML/CSS/JSをlocalhostで配信し、左右反転の回数・座標一致・縦横比・リサイズ・画素密度2・透明Canvas・双方向リンク・反転されないUIを確認します。自動テストではカメラ・MediaPipeを代替し、ブラウザテストは外部接続を制限しています。実カメラでの顔認識と0.10.14による実モデル実行は未確認です.

利用するPCのChromeで次を確認してください。

1. 両ページでカメラ許可後の映像と線が左右反転し、指先/鼻先と線の位置が一致すること。
2. 指ページで左右それぞれの手に対して指定ジェスチャーだけが描画を開始し、親指の位置は判定に影響しないこと。
3. 鼻ページで顔を動かすと線が描かれ、顔を隠す・タブを切り替える・停止後に再開すると離れた線をつながないこと。
4. リサイズ時の位置一致・保持、リロード時の消去、両ページ間のリンクが読めて機能すること。
5. カメラ拒否、モデル読込失敗時の簡潔なエラー表示。
