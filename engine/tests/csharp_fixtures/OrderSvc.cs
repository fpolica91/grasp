// dreplay C# FLOW conformance fixture — a real, checked-in C# program.
//
// OrderSvc models a tiny order-creation flow with the shapes the Flow instrument
// must observe: an auth check (Verify), a business transform (Compute), a write
// indicator on the returned object (Saved), and a declared model (OrderRecord) whose
// fields are the vocabulary the classifier should derive.
//
// This file is consumed by tests/test_csharp_flow.py via the csharp_flow adapter.
// It is plain C# (net8.0); the tracer compiles it in-memory with Roslyn.

using System;
using System.Collections.Generic;

namespace Fixtures
{
    // A declared model — its fields (Name, Amount, Currency, Saved) are the vocabulary.
    public class OrderRecord
    {
        public string Name { get; set; } = "";
        public int Amount { get; set; }
        public string Currency { get; set; } = "USD";
        public bool Saved { get; set; }
    }

    public class OrderSvc
    {
        // Auth check: the entrypoint calls this conditionally. When it fires, the
        // tracer observes an auth_check node; when it doesn't, the AST-derived
        // auth_calls map surfaces an auth-not-executed node.
        public static bool Verify(string token)
        {
            return !string.IsNullOrEmpty(token) && token.Length >= 3;
        }

        // A business transform the entrypoint calls — interior, observed.
        public int Compute(int qty, int unitPrice)
        {
            return qty * unitPrice;
        }

        // The entrypoint. Positional kwargs (name, qty) map onto this signature.
        public Dictionary<string, object> CreateOrder(string name, int qty)
        {
            var ok = Verify(name);
            if (!ok)
            {
                return new Dictionary<string, object> { ["saved"] = false };
            }
            var amount = Compute(qty, 10);
            return new Dictionary<string, object>
            {
                ["name"] = name,
                ["amount"] = amount,
                ["saved"] = true,
            };
        }

        // A path that throws — the tracer observes the exception (observed endpoint).
        public string Deny(string user)
        {
            if (string.IsNullOrEmpty(user))
            {
                throw new ArgumentException("missing user");
            }
            return "ok:" + user;
        }
    }
}
