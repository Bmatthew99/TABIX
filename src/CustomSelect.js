// src/CustomSelect.js
import React, { useState, useRef, useEffect } from "react";
import "./CustomSelect.css";

function CustomSelect({
  options,
  value,
  onChange,
  placeholder = "Оберіть...",
}) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef(null);

  const toggleDropdown = () => setIsOpen((prev) => !prev);

  const handleOptionClick = (option) => {
    onChange(option);
    setIsOpen(false);
  };

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <div className="custom-select" ref={dropdownRef}>
      <div className="custom-select__control" onClick={toggleDropdown}>
        <span className="custom-select__value">{value || placeholder}</span>
        <span className="custom-select__arrow">{isOpen ? "▲" : "▼"}</span>
      </div>
      {isOpen && (
        <div className="custom-select__menu">
          {options.map((option, index) => (
            <div
              key={index}
              className="custom-select__option"
              onClick={() => handleOptionClick(option)}
            >
              {option}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default CustomSelect;
