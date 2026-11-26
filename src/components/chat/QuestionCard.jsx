import React, { useState } from "react";
import { ArrowRight } from "lucide-react";

export function getClarificationQuestions(content) {
  const text = String(content || "").trim();
  const match = /^Before I proceed, please clarify:\s*([\s\S]+)$/i.exec(text);
  if (match) {
    return match[1]
      .split(/\r?\n/)
      .map((line) => line.replace(/^\s*[-*]\s*/, "").trim())
      .filter(Boolean)
      .slice(0, 4);
  }
  if (/^What text should I post\?$/i.test(text)) return [text];
  return [];
}

function choicesFor(question) {
  const optionText = question.match(/:\s*(.+?)(?:\?|$)/)?.[1];
  const choices = optionText
    ? optionText.split(/\s*,\s*|\s+or\s+/i).map((choice) => choice.replace(/^["'“”‘’]|["'“”‘’]$/g, "").trim()).filter(Boolean)
    : [];
  if (choices.length >= 2) {
    const fallbacks = ["Use a sensible default", "Not sure"];
    return [...choices.slice(0, 4), ...fallbacks].slice(0, 4);
  }
  return ["Use a sensible default", "Keep it simple", "Surprise me", "I’ll provide details"];
}

export default function QuestionCard({ questions, onAnswer }) {
  const [questionIndex, setQuestionIndex] = useState(0);
  const [selected, setSelected] = useState([]);
  const [other, setOther] = useState("");
  const [answers, setAnswers] = useState([]);
  const question = questions[questionIndex];
  if (!question) return null;

  const multiChoice = /\b(select all|choose any|any of the following)\b/i.test(question);
  const options = choicesFor(question);
  const finishAnswer = (answer) => {
    if (questionIndex + 1 < questions.length) {
      setAnswers((current) => [...current, answer]);
      setQuestionIndex((index) => index + 1);
      setSelected([]);
      setOther("");
      return;
    }
    onAnswer([...answers, answer].map((value, index) => `${index + 1}. ${questions[index]}: ${value}`).join("\n"));
  };
  const submitOther = () => {
    if (other.trim()) finishAnswer(other.trim());
  };

  return (
    <section aria-label="Question from Biz" className="mb-3 rounded-2xl border border-primary/20 bg-card px-4 py-3 shadow-sm">
      <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
        <span className="font-medium text-foreground">A quick question</span>
        <span>{questionIndex + 1} of {questions.length}</span>
      </div>
      <p className="mb-3 text-sm font-medium leading-5 text-foreground">{question}</p>
      <div className="grid grid-cols-2 gap-2">
        {options.map((option) => {
          const checked = selected.includes(option);
          return (
            <button
              key={option}
              type="button"
              role={multiChoice ? "checkbox" : "radio"}
              aria-checked={checked}
              onClick={() => {
                if (multiChoice) {
                  setSelected((current) => checked ? current.filter((item) => item !== option) : [...current, option]);
                } else {
                  finishAnswer(option);
                }
              }}
              className={`flex min-h-10 items-center gap-2 rounded-xl border px-3 py-2 text-left text-xs transition-colors ${checked ? "border-primary bg-primary/10 text-foreground" : "border-border/70 bg-background hover:bg-accent"}`}
            >
              <span className={`h-3.5 w-3.5 shrink-0 border ${multiChoice ? "rounded" : "rounded-full"} ${checked ? "border-primary bg-primary" : "border-muted-foreground/50"}`} />
              {option}
            </button>
          );
        })}
      </div>
      <label className="mt-2 flex min-h-10 items-center gap-2 rounded-xl border border-border/70 bg-background px-3">
        <input
          value={other}
          onChange={(event) => setOther(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              submitOther();
            }
          }}
          placeholder="Something else"
          className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
        />
        <button type="button" aria-label="Send answer" disabled={!other.trim()} onClick={submitOther} className="rounded-md p-1.5 text-primary disabled:opacity-40">
          <ArrowRight className="h-4 w-4" />
        </button>
      </label>
      <div className="mt-2 flex items-center justify-between">
        <button type="button" onClick={() => finishAnswer("Skip")} className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground">
          Skip
        </button>
        {multiChoice && (
          <button type="button" disabled={!selected.length} onClick={() => finishAnswer(selected.join(", "))} className="inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-40">
            {selected.length} selected <ArrowRight className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </section>
  );
}
