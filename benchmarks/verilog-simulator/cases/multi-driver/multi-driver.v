module multi_driver_bench;
  integer i;
  reg enable_a;
  reg enable_b;
  reg [31:0] value_a;
  reg [31:0] value_b;
  tri [31:0] resolved;

  assign resolved = enable_a ? value_a : {32{1'bz}};
  assign resolved = enable_b ? value_b : {32{1'bz}};

  initial begin
    enable_a = 0;
    enable_b = 0;
    value_a = 0;
    value_b = 0;
    for (i = 0; i < 20000; i = i + 1) begin
      value_a = i ^ 32'ha5a55a5a;
      value_b = ~value_a;
      case (i & 3)
        0: begin enable_a = 1; enable_b = 0; end
        1: begin enable_a = 0; enable_b = 1; end
        2: begin enable_a = 1; enable_b = 1; value_b = value_a; end
        3: begin enable_a = 1; enable_b = 1; end
      endcase
      #1;
      case (i & 3)
        0, 2: if (resolved !== value_a) begin
          $display("FAIL multi-driver");
          $finish;
        end
        1: if (resolved !== value_b) begin
          $display("FAIL multi-driver");
          $finish;
        end
        3: if (resolved !== {32{1'bx}}) begin
          $display("FAIL multi-driver");
          $finish;
        end
      endcase
    end
    $display("PASS multi-driver");
    $finish;
  end
endmodule
