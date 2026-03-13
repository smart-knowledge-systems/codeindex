using System;
using System.Collections.Generic;

namespace SampleApp
{
    public interface ILogger
    {
        void Log(string message);
    }

    [Serializable]
    public class ConsoleLogger : ILogger
    {
        private readonly string _prefix;
        public string Name { get; set; }

        public ConsoleLogger(string prefix)
        {
            _prefix = prefix;
        }

        public void Log(string message)
        {
            Console.WriteLine($"{_prefix}: {message}");
        }

        [Obsolete("Use Create instead")]
        public static ConsoleLogger Create(string prefix)
        {
            return new ConsoleLogger(prefix);
        }
    }
}
