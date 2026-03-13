import React, { useState } from "react";

interface ButtonProps {
  label: string;
  onClick: () => void;
}

export function Button({ label, onClick }: ButtonProps) {
  return <button onClick={onClick}>{label}</button>;
}

export function useCounter(initial: number) {
  const [count, setCount] = useState(initial);
  return { count, increment: () => setCount(count + 1) };
}
