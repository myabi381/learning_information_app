// Code.gs

// ★ここに自分のスプレッドシートのURLを貼る
var SPREADSHEET_URL =
  '###########################################################################################################';//ここには、スプレッドシートのURLを貼り付ける。

// シート名
var SHEET_QUESTION_DB  = '問題DB';
var SHEET_LOG          = '解答ログ';
var SHEET_USER_STATS   = 'ユーザ集計';
var SHEET_USER_WEIGHTS = 'ユーザ重み';

// ===== 共通ヘルパ =====
function openSheet_(name) {
  var ss = SpreadsheetApp.openByUrl(SPREADSHEET_URL);
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
  }
  return sheet;
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

// ===== 問題取得関連 =====

// 問題DBから問題一覧を取得
// unitFilters, rangeFilters は文字列配列（空ならフィルタなし）
function getQuestions(unitFilters, rangeFilters) {
  var sheet = openSheet_(SHEET_QUESTION_DB);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  // A:問題ID, B:問題形式, C:問題文,
  // D:選択肢1, E:選択肢2, F:選択肢3, G:選択肢4,
  // H:正答,
  // I:解説1, J:解説2, K:解説3, L:解説4,
  // M:単元, N:テスト範囲
  var values = sheet.getRange(2, 1, lastRow - 1, 14).getValues();

  var questions = values.map(function (row) {
    return {
      id: String(row[0]),
      type: row[1],          // "多肢選択" / "正誤問題" / "記述問題"
      text: row[2],
      choices: [row[3], row[4], row[5], row[6]],
      correct: row[7],
      explanation1: row[8],
      explanation2: row[9],
      explanation3: row[10],
      explanation4: row[11],
      unit: row[12],
      range: row[13]
    };
  });

  if (unitFilters && unitFilters.length) {
    var unitSet = {};
    unitFilters.forEach(function (u) {
      if (u) unitSet[u] = true;
    });
    questions = questions.filter(function (q) {
      return q.unit && unitSet[q.unit];
    });
  }

  if (rangeFilters && rangeFilters.length) {
    var rangeSet = {};
    rangeFilters.forEach(function (r) {
      if (r) rangeSet[r] = true;
    });
    questions = questions.filter(function (q) {
      return q.range && rangeSet[q.range];
    });
  }

  // IDでソート
  questions.sort(function (a, b) {
    return Number(a.id) - Number(b.id);
  });

  return questions;
}

// 単元一覧（重複なし）
function getUnitOptions() {
  var sheet = openSheet_(SHEET_QUESTION_DB);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var values = sheet.getRange(2, 13, lastRow - 1, 1).getValues(); // M列:単元

  var map = {};
  var res = [];
  values.forEach(function (row) {
    var v = row[0];
    if (v !== '' && v != null && !map[v]) {
      map[v] = true;
      res.push(v);
    }
  });
  res.sort();
  return res;
}

// テスト範囲一覧（重複なし）
function getRangeOptions() {
  var sheet = openSheet_(SHEET_QUESTION_DB);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var values = sheet.getRange(2, 14, lastRow - 1, 1).getValues(); // N列:テスト範囲

  var map = {};
  var res = [];
  values.forEach(function (row) {
    var v = row[0];
    if (v !== '' && v != null && !map[v]) {
      map[v] = true;
      res.push(v);
    }
  });
  res.sort();
  return res;
}

// ===== ユーザ集計 =====

function getUserStats(email) {
  if (!email) return null;

  var sheet = openSheet_(SHEET_USER_STATS);
  var lastRow = sheet.getLastRow();

  // ヘッダがなければ作る
  if (lastRow === 0) {
    sheet.appendRow(['ユーザ', '累計', '正解累計']);
    lastRow = 1;
  }

  if (lastRow < 2) {
    return { total: 0, correct: 0 };
  }

  var values = sheet.getRange(2, 1, lastRow - 1, 3).getValues();
  for (var i = 0; i < values.length; i++) {
    if (values[i][0] === email) {
      return {
        total: values[i][1] || 0,
        correct: values[i][2] || 0
      };
    }
  }

  // なければ新規行
  var newRow = lastRow + 1;
  sheet.getRange(newRow, 1, 1, 3).setValues([[email, 0, 0]]);
  return { total: 0, correct: 0 };
}

function updateUserStats(email, isCorrect) {
  if (!email) return;

  var sheet = openSheet_(SHEET_USER_STATS);
  var lastRow = sheet.getLastRow();

  if (lastRow === 0) {
    sheet.appendRow(['ユーザ', '累計', '正解累計']);
    lastRow = 1;
  }

  var targetRow = -1;
  if (lastRow >= 2) {
    var users = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (var i = 0; i < users.length; i++) {
      if (users[i][0] === email) {
        targetRow = i + 2;
        break;
      }
    }
  }

  if (targetRow === -1) {
    targetRow = lastRow + 1;
    sheet.getRange(targetRow, 1, 1, 3).setValues([[email, 0, 0]]);
  }

  var rowVals = sheet.getRange(targetRow, 1, 1, 3).getValues()[0];
  var total   = rowVals[1] || 0;
  var correct = rowVals[2] || 0;

  total++;
  if (isCorrect) correct++;

  sheet.getRange(targetRow, 2, 1, 2).setValues([[total, correct]]);
}

// ===== ユーザ重み（出題確率調整） =====

// ユーザごとの重みを使って、候補問題から1問を重み付きランダムで選ぶ
// デフォルト重み: 10, 最小1, 最大100
function pickWeightedQuestion(email, questions) {
  if (!questions || !questions.length) return null;

  var sheet = openSheet_(SHEET_USER_WEIGHTS);
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();

  if (lastRow === 0) {
    sheet.appendRow(['ユーザ']); // A1
    lastRow = 1;
    lastCol = 1;
  }

  if (lastCol < 1) {
    lastCol = 1;
  }

  var header = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var headerMap = {};
  for (var c = 0; c < header.length; c++) {
    if (header[c]) headerMap[header[c]] = c + 1;
  }

  // 必要な問題IDの列がなければ追加
  var changedHeader = false;
  questions.forEach(function (q) {
    if (!headerMap[q.id]) {
      header.push(q.id);
      headerMap[q.id] = header.length;
      changedHeader = true;
    }
  });

  if (changedHeader) {
    sheet.getRange(1, 1, 1, header.length).setValues([header]);
    lastCol = header.length;
  }

  // ユーザ行を探す
  var rowIndex = -1;
  if (lastRow >= 2) {
    var users = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (var r = 0; r < users.length; r++) {
      if (users[r][0] === email) {
        rowIndex = r + 2;
        break;
      }
    }
  }
  if (rowIndex === -1) {
    rowIndex = lastRow + 1;
    sheet.getRange(rowIndex, 1).setValue(email);
  }

  // 各問題の重みを取得（空なら10をセット）
  var weights = [];
  var totalWeight = 0;
  for (var i = 0; i < questions.length; i++) {
    var q = questions[i];
    var colIndex = headerMap[q.id];
    var cell = sheet.getRange(rowIndex, colIndex);
    var value = cell.getValue();
    var weight = parseInt(value, 10);
    if (!weight || weight < 1) {
      weight = 10;
      cell.setValue(weight);
    }
    if (weight < 1) weight = 1;
    if (weight > 100) weight = 100;

    weights.push(weight);
    totalWeight += weight;
  }

  if (totalWeight <= 0) {
    var fallbackIndex = Math.floor(Math.random() * questions.length);
    return questions[fallbackIndex];
  }

  // 重み付きランダム
  var rand = Math.random() * totalWeight;
  var cumulative = 0;
  for (var j = 0; j < questions.length; j++) {
    cumulative += weights[j];
    if (rand < cumulative) {
      return questions[j];
    }
  }
  return questions[questions.length - 1];
}

// 正解/不正解に応じて重みを更新
// 正解: weight = max(weight - 1, 1)
// 不正解: weight = min(weight + 5, 100)
function updateUserWeight(email, questionId, isCorrect) {
  if (!email) return;

  var sheet = openSheet_(SHEET_USER_WEIGHTS);
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();

  if (lastRow === 0) {
    sheet.appendRow(['ユーザ']);
    lastRow = 1;
    lastCol = 1;
  }

  if (lastCol < 1) lastCol = 1;

  var header = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var headerMap = {};
  for (var c = 0; c < header.length; c++) {
    if (header[c]) headerMap[header[c]] = c + 1;
  }

  var changedHeader = false;
  if (!headerMap[questionId]) {
    header.push(questionId);
    headerMap[questionId] = header.length;
    changedHeader = true;
  }
  if (changedHeader) {
    sheet.getRange(1, 1, 1, header.length).setValues([header]);
    lastCol = header.length;
  }

  // ユーザ行
  var rowIndex = -1;
  if (lastRow >= 2) {
    var users = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (var r = 0; r < users.length; r++) {
      if (users[r][0] === email) {
        rowIndex = r + 2;
        break;
      }
    }
  }
  if (rowIndex === -1) {
    rowIndex = lastRow + 1;
    sheet.getRange(rowIndex, 1).setValue(email);
  }

  var header2 = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var headerMap2 = {};
  for (var cc = 0; cc < header2.length; cc++) {
    if (header2[cc]) headerMap2[header2[cc]] = cc + 1;
  }

  var colIndex = headerMap2[questionId];
  var cell = sheet.getRange(rowIndex, colIndex);
  var value = cell.getValue();
  var weight = parseInt(value, 10);
  if (!weight) weight = 10;

  if (isCorrect) {
    weight = Math.max(weight - 1, 1);
  } else {
    weight = Math.min(weight + 5, 100);
  }
  cell.setValue(weight);
}

// ===== 解答ログ =====
function logAnswer(email, question, isCorrect, userAnswer) {
  var sheet = openSheet_(SHEET_LOG);
  var lastRow = sheet.getLastRow();

  if (lastRow === 0) {
    sheet.appendRow([
      'タイムスタンプ',
      'ユーザ',
      '問題ID',
      '問題形式',
      '正誤',
      'ユーザ回答',
      '正答',
      '単元',
      'テスト範囲'
    ]);
  }

  sheet.appendRow([
    new Date(),
    email || '',
    question.id,
    question.type,
    isCorrect ? '○' : '×',
    userAnswer,
    question.correct,
    question.unit,
    question.range
  ]);
}

// ===== Webアプリのエントリ =====

function doGet(e) {
  e = e || {};
  var params = e.parameter || {};
  var page = params.page || 'home';

  var email = Session.getActiveUser().getEmail() || '';
  var webAppUrl = ScriptApp.getService().getUrl();

  if (page === 'quiz') {
    var unitFiltersStr = params.unitFilters || '';
    var rangeFiltersStr = params.rangeFilters || '';

    var unitFilters = unitFiltersStr
      ? unitFiltersStr.split(',').filter(function (s) { return s; })
      : [];
    var rangeFilters = rangeFiltersStr
      ? rangeFiltersStr.split(',').filter(function (s) { return s; })
      : [];

    var questions = getQuestions(unitFilters, rangeFilters);
    if (!questions.length) {
      return HtmlService.createHtmlOutput('該当する問題が登録されていません。');
    }

    var firstQuestion = pickWeightedQuestion(email || 'anonymous', questions);

    var template = HtmlService.createTemplateFromFile('quiz');
    template.question      = firstQuestion;
    template.userEmail     = email;
    template.userStats     = getUserStats(email);
    template.unitFilters   = unitFiltersStr;
    template.rangeFilters  = rangeFiltersStr;
    template.webAppUrl     = webAppUrl;

    return template
      .evaluate()
      .setTitle('情報I 学習サイト - 問題')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }

  // デフォルト: ホーム画面
  var templateHome = HtmlService.createTemplateFromFile('home');
  templateHome.userEmail    = email;
  templateHome.userStats    = getUserStats(email);
  templateHome.unitOptions  = getUnitOptions();
  templateHome.rangeOptions = getRangeOptions();
  templateHome.webAppUrl    = webAppUrl;

  return templateHome
    .evaluate()
    .setTitle('情報I 学習サイト - ホーム')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ===== 解答チェック（フロントから google.script.run で呼び出し） =====
//
// questionType と unitFilters / rangeFilters も一緒に渡す前提
//
function checkAnswer(questionId, userAnswer, questionType, unitFiltersStr, rangeFiltersStr) {
  var email = Session.getActiveUser().getEmail() || '';

  var unitFilters = unitFiltersStr
    ? unitFiltersStr.split(',').filter(function (s) { return s; })
    : [];
  var rangeFilters = rangeFiltersStr
    ? rangeFiltersStr.split(',').filter(function (s) { return s; })
    : [];

  var questions = getQuestions(unitFilters, rangeFilters);
  if (!questions.length) {
    throw new Error('問題が見つかりません。');
  }

  var current = null;
  for (var i = 0; i < questions.length; i++) {
    if (String(questions[i].id) === String(questionId)) {
      current = questions[i];
      break;
    }
  }
  if (!current) {
    throw new Error('問題ID ' + questionId + ' が見つかりません。');
  }

  var type = current.type || questionType;
  var isCorrect = false;
  var correctLabel = null;
  var correctValue = current.correct;

  if (type === '多肢選択') {
    var labels = ['ア', 'イ', 'ウ', 'エ'];
    var correctIndex = current.choices.findIndex(function (c) {
      return String(c) === String(current.correct);
    });
    if (correctIndex < 0) correctIndex = 0;
    correctLabel = labels[correctIndex];

    // userAnswer は 'ア', 'イ', 'ウ', 'エ' を受け取る想定
    isCorrect = (userAnswer === correctLabel);
  } else if (type === '正誤問題') {
    isCorrect =
      String(userAnswer).toLowerCase() === String(current.correct).toLowerCase();
  } else if (type === '記述問題') {
    isCorrect =
      String(userAnswer).trim() === String(current.correct).trim();
  } else {
    isCorrect = String(userAnswer) === String(current.correct);
  }

  // ログ・集計・重み更新
  logAnswer(email, current, isCorrect, userAnswer);
  if (email) {
    updateUserStats(email, isCorrect);
    updateUserWeight(email, current.id, isCorrect);
  }

  // 最新の累計を取得して返す
  var updatedStats = email ? getUserStats(email) : null;

  // 次の問題
  var nextQuestion = pickWeightedQuestion(email || 'anonymous', questions);

  return {
    isCorrect: isCorrect,
    questionType: type,
    correctLabel: correctLabel,
    correctValue: correctValue,
    explanations: [
      current.explanation1,
      current.explanation2,
      current.explanation3,
      current.explanation4
    ],
    nextQuestion: nextQuestion,
    userStats: updatedStats
  };
}
