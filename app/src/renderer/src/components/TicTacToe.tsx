import { useState, useMemo } from "react";

type Player = "X" | "O";
type Cell = Player | null;
type Board = Cell[];

const WINNING_LINES = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
];

export function calculateWinner(board: Board): { player: Player; line: number[] } | null {
  for (const line of WINNING_LINES) {
    const [a, b, c] = line;
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return { player: board[a]!, line };
    }
  }
  return null;
}

function getInitialBoard(): Board {
  return Array(9).fill(null);
}

export function TicTacToe() {
  const [board, setBoard] = useState<Board>(getInitialBoard);
  const [xIsNext, setXIsNext] = useState(true);

  const winner = useMemo(() => calculateWinner(board), [board]);
  const isDraw = !winner && board.every((cell) => cell !== null);
  const gameOver = winner !== null || isDraw;

  const statusText = winner
    ? `Winner: ${winner.player}`
    : isDraw
      ? "It's a draw!"
      : `Next player: ${xIsNext ? "X" : "O"}`;

  function handleClick(index: number) {
    if (gameOver || board[index]) return;
    const nextBoard = board.slice();
    nextBoard[index] = xIsNext ? "X" : "O";
    setBoard(nextBoard);
    setXIsNext(!xIsNext);
  }

  function reset() {
    setBoard(getInitialBoard());
    setXIsNext(true);
  }

  function isWinningCell(index: number): boolean {
    return winner?.line.includes(index) ?? false;
  }

  return (
    <div style={styles.container}>
      <h1 style={styles.title}>Tic-Tac-Toe</h1>
      <div style={styles.status}>{statusText}</div>
      <div style={styles.board}>
        {board.map((cell, index) => (
          <button
            key={index}
            onClick={() => handleClick(index)}
            style={{
              ...styles.cell,
              ...(isWinningCell(index) ? styles.winningCell : null),
              color: cell === "X" ? "#2563eb" : "#dc2626",
            }}
          >
            {cell}
          </button>
        ))}
      </div>
      <button onClick={reset} style={styles.resetButton}>
        {gameOver ? "Play again" : "Reset"}
      </button>
    </div>
  );
}

const styles = {
  container: {
    display: "flex",
    flexDirection: "column" as const,
    alignItems: "center",
    fontFamily: "system-ui, sans-serif",
    padding: "32px",
    gap: "16px",
  },
  title: {
    margin: 0,
    fontSize: "28px",
  },
  status: {
    fontSize: "18px",
    fontWeight: 600,
    minHeight: "24px",
  },
  board: {
    display: "grid",
    gridTemplateColumns: "repeat(3, 80px)",
    gridTemplateRows: "repeat(3, 80px)",
    gap: "6px",
  },
  cell: {
    width: "80px",
    height: "80px",
    fontSize: "36px",
    fontWeight: 700,
    cursor: "pointer",
    border: "1px solid #cbd5e1",
    borderRadius: "8px",
    backgroundColor: "#f8fafc",
  },
  winningCell: {
    backgroundColor: "#bbf7d8",
    borderColor: "#22c55e",
  },
  resetButton: {
    marginTop: "8px",
    padding: "10px 20px",
    fontSize: "15px",
    fontWeight: 600,
    cursor: "pointer",
    border: "1px solid #cbd5e1",
    borderRadius: "8px",
    backgroundColor: "#fff",
  },
};
